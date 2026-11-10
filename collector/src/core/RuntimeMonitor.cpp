#include "core/RuntimeMonitor.h"
#include "core/Engine.h"
#include <winsock2.h>
#include <ws2ipdef.h>
#include <Windows.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <Psapi.h>
#include <algorithm>

namespace mcarchive {
void RuntimeMonitor::tick(int onlinePlayers) noexcept {
    std::lock_guard lock(mutex);auto now=Clock::now();
    if(lastTickAt)maxInterval=std::max(maxInterval,std::chrono::duration<double,std::milli>(now-lastTick).count());
    lastTick=now;lastTickAt=nowMillis();players=onlinePlayers;++ticks;
}
nlohmann::json RuntimeMonitor::sample(bool stopped) {
    auto now=Clock::now();std::int64_t elapsed; nlohmann::json result;
    {std::lock_guard lock(mutex);elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(now-window).count();
    if(elapsed<1000&&!stopped)return nullptr;
    auto at=nowMillis();
    result={{"sequence",++sequence},{"at",timestamp(at)},{"windowMillis",std::max<std::int64_t>(1,elapsed)},
        {"uptimeMillis",std::chrono::duration_cast<std::chrono::milliseconds>(now-started).count()},
        {"ticks",ticks},{"players",players},{"lastTickAt",lastTickAt?nlohmann::json(timestamp(lastTickAt)):nlohmann::json(nullptr)},
        {"maxTickIntervalMillis",std::max(maxInterval,lastTickAt?std::chrono::duration<double,std::milli>(now-lastTick).count():0.0)},
        {"cpuPercent",nullptr},{"workingSetBytes",nullptr},{"privateBytes",nullptr},{"hostMemoryTotalBytes",nullptr},{"hostMemoryAvailableBytes",nullptr},{"stopped",stopped}};
    window=now;ticks=0;maxInterval=0;}
    // Slow OS reads stay off the game tick lock and off the game thread.
    FILETIME creation{},exit{},kernel{},user{};
    if(GetProcessTimes(GetCurrentProcess(),&creation,&exit,&kernel,&user)){
        auto value=[](FILETIME f){return (std::uint64_t(f.dwHighDateTime)<<32)|f.dwLowDateTime;};
        auto cpu=value(kernel)+value(user);auto cores=GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
        if(hasCpu&&cores&&cpu>=previousCpu)result["cpuPercent"]=std::clamp(double(cpu-previousCpu)/10000.0/std::max<std::int64_t>(1,elapsed)/cores*100.0,0.0,100.0);
        previousCpu=cpu;hasCpu=true;
    }else hasCpu=false;
    PROCESS_MEMORY_COUNTERS_EX memory{};memory.cb=sizeof(memory);
    if(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory))){result["workingSetBytes"]=memory.WorkingSetSize;result["privateBytes"]=memory.PrivateUsage;}
    MEMORYSTATUSEX host{};host.dwLength=sizeof(host);
    if(GlobalMemoryStatusEx(&host)){result["hostMemoryTotalBytes"]=host.ullTotalPhys;result["hostMemoryAvailableBytes"]=host.ullAvailPhys;}
    result["hostCpuPercent"]=nullptr;result["hostNetworkReceiveBps"]=nullptr;result["hostNetworkSendBps"]=nullptr;
    auto cores=GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);result["hostLogicalProcessors"]=cores;
    FILETIME idle{},systemKernel{},systemUser{};
    if(cores<=64&&GetSystemTimes(&idle,&systemKernel,&systemUser)){
        auto value=[](FILETIME f){return (std::uint64_t(f.dwHighDateTime)<<32)|f.dwLowDateTime;};
        auto total=value(systemKernel)+value(systemUser),idleValue=value(idle);
        if(hasHostCpu&&total>hostTotal&&idleValue>=hostIdle)result["hostCpuPercent"]=std::clamp(100.0*(1.0-double(idleValue-hostIdle)/double(total-hostTotal)),0.0,100.0);
        hostTotal=total;hostIdle=idleValue;hasHostCpu=true;
    }else hasHostCpu=false;
    result["hostDisks"]=nlohmann::json::array();auto drives=GetLogicalDrives();
    for(unsigned i=0;i<26;i++)if(drives&(1u<<i)){
        wchar_t root[]={wchar_t(L'A'+i),L':',L'\\',0};ULARGE_INTEGER available{},total{},free{};
        if(GetDriveTypeW(root)==DRIVE_FIXED&&GetDiskFreeSpaceExW(root,&available,&total,&free)&&total.QuadPart>0)
            result["hostDisks"].push_back({{"drive",std::string(1,char('A'+i))+":"},{"totalBytes",total.QuadPart},{"availableBytes",free.QuadPart}});
    }
    PMIB_IF_TABLE2 table=nullptr;
    if(GetIfTable2(&table)==NO_ERROR){
        std::map<std::uint64_t,std::pair<std::uint64_t,std::uint64_t>> current;std::uint64_t received=0,sent=0;bool measured=false;
        for(ULONG i=0;i<table->NumEntries;i++){auto const& row=table->Table[i];
            if(!row.InterfaceAndOperStatusFlags.HardwareInterface||row.OperStatus!=IfOperStatusUp||row.Type==IF_TYPE_SOFTWARE_LOOPBACK)continue;
            auto id=row.InterfaceLuid.Value;auto previous=interfaces.find(id);current[id]={row.InOctets,row.OutOctets};
            if(previous!=interfaces.end()&&row.InOctets>=previous->second.first&&row.OutOctets>=previous->second.second){received+=row.InOctets-previous->second.first;sent+=row.OutOctets-previous->second.second;measured=true;}
        }
        FreeMibTable(table);interfaces=std::move(current);
        if(measured){result["hostNetworkReceiveBps"]=received*1000.0/std::max<std::int64_t>(1,elapsed);result["hostNetworkSendBps"]=sent*1000.0/std::max<std::int64_t>(1,elapsed);}
    }else interfaces.clear();
    return result;
}
}
