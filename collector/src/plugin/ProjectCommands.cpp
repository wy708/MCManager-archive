#include "plugin/ProjectCommands.h"
#include "plugin/GameTracker.h"
#include "core/Transport.h"
#include "core/Platform.h"
#include "ll/api/command/CommandHandle.h"
#include "ll/api/command/CommandRegistrar.h"
#include "mc/server/commands/CommandOrigin.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/Level.h"
#include <condition_variable>
#include <cmath>
#include <deque>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace mcarchive {
struct ProjectParameters {std::string action;std::string name;};
namespace {
using json=nlohmann::json;
struct Target {virtual void command(Player&,ProjectParameters const&,CommandOutput&)=0;virtual ~Target()=default;};
std::mutex lifetime;Target* active=nullptr;
struct Selection {std::string dimension;std::optional<std::pair<int,int>> first,second;};
struct Request {std::string player;json operation;};
struct Result {std::string player,text;};
}
struct ProjectCommands::Impl:Target {
    HttpTransport transport;std::string endpoint;
    std::mutex mutex;std::condition_variable changed;bool stopping=false;std::thread worker;
    std::deque<Request> queue;std::deque<Result> results;
    std::unordered_map<std::string,Selection> selections;
    std::unordered_map<std::string,json> lastRequests;
    std::unordered_set<std::string> pending;
    explicit Impl(EngineConfig const& config):transport(config.endpoint,config.token),endpoint(config.endpoint){
        auto slash=endpoint.find("/api/");if(slash!=std::string::npos)endpoint.resize(slash);
        std::lock_guard guard(lifetime);if(active)throw std::runtime_error("Project commands already enabled");
        auto& command=ll::command::CommandRegistrar::getServerInstance().getOrCreateCommand("project","施工工程：pos1 / pos2 / create 名称 / range 名称 / finish 名称 / resume 名称 / retry",CommandPermissionLevel::Any);
        command.overload<ProjectParameters>().required("action").optional("name").execute([](CommandOrigin const& origin,CommandOutput& output,ProjectParameters const& parameters){
            std::lock_guard guard(lifetime);auto actor=origin.getEntity();
            if(!active || origin.getOriginType()!=CommandOriginType::Player || !actor || !actor->isPlayer()){output.error("请在游戏内由玩家执行 /project");return;}
            auto& player=static_cast<Player&>(*actor);if(!player.isPlayerInitialized()){output.error("请等待玩家加载完成");return;}
            active->command(player,parameters,output);
        });
        worker=std::thread([this]{run();});active=this;
    }
    void command(Player& player,ProjectParameters const& parameters,CommandOutput& output) override {
        auto key=stablePlayerKey(player);auto action=parameters.action;
        std::lock_guard guard(mutex);
        if(action=="pos1" || action=="pos2"){
            if(selections.size()>=1024 && !selections.contains(key)){output.error("选点人数过多，请稍后重试");return;}
            auto& selection=selections[key];auto dimension=playerDimension(player);
            if(selection.dimension!=dimension){selection={};selection.dimension=dimension;}
            auto position=player.getPosition();auto point=std::pair{static_cast<int>(std::floor(position.x)),static_cast<int>(std::floor(position.z))};
            (action=="pos1"?selection.first:selection.second)=point;
            output.success("已选点 X="+std::to_string(point.first)+" Z="+std::to_string(point.second)+"（包含所有高度）");return;
        }
        if(stopping || pending.contains(key) || pending.size()>=32){output.error("工程请求正在处理，请稍后再试");return;}
        json operation;
        if(action=="retry"){
            if(!lastRequests.contains(key)){output.error("没有可以重试的请求");return;}
            operation=lastRequests.at(key);
        } else {
            std::string verb=action=="create"?"CREATE":action=="range"?"UPDATE":action=="finish"?"COMPLETE":action=="resume"?"RESUME":"";
            if(verb.empty() || parameters.name.empty()){output.error("用法：/project pos1、pos2；/project create、range、finish、resume 工程名；/project retry。带空格的名称请加双引号。");return;}
            operation={{"requestId",uuid()},{"action",verb},{"name",parameters.name}};
            if(verb=="CREATE" || verb=="UPDATE"){
                auto found=selections.find(key);
                if(found==selections.end() || !found->second.first || !found->second.second || found->second.dimension!=playerDimension(player)){output.error("请先在同一维度使用 /project pos1 和 /project pos2 选两个点");return;}
                auto& s=found->second;operation["dimension"]=s.dimension;operation["x1"]=s.first->first;operation["z1"]=s.first->second;operation["x2"]=s.second->first;operation["z2"]=s.second->second;
            }
            if(lastRequests.size()>=1024 && !lastRequests.contains(key)){output.error("请求记录已满，请联系管理员");return;}
            lastRequests[key]=operation;
        }
        queue.push_back({key,operation});pending.insert(key);changed.notify_one();output.success("正在处理工程请求，结果会通过个人消息送达");
    }
    void run() noexcept {
        for(;;){
            Request request;{
                std::unique_lock guard(mutex);changed.wait(guard,[this]{return stopping || !queue.empty();});if(stopping)return;
                request=std::move(queue.front());queue.pop_front();
            }
            std::string message="结果尚未确认，请用 /project retry 重试同一请求，不要重复创建。";
            try {
                auto response=transport.postCommand("/projects",json{{"playerKey",request.player},{"operation",request.operation}}.dump());
                if(response.status==200 && response.error.empty()){
                    auto result=json::parse(response.body);
                    if(result.at("requestId")==request.operation.at("requestId"))message=result.at("message").get<std::string>()+"\n"+endpoint+result.at("publicUrl").get<std::string>();
                } else if(response.status>=400 && response.status<500){
                    auto error=json::parse(response.body,nullptr,false);
                    message="工程请求未接受："+(error.is_object()?error.value("detail",error.value("message",std::string("请检查工程名、创建者权限和施工状态"))):"请检查工程名、创建者权限和施工状态");
                }
            }catch(...){}
            std::lock_guard guard(mutex);results.push_back({request.player,std::move(message)});
        }
    }
    void tick(Level& level){
        std::deque<Result> ready;{std::lock_guard guard(mutex);ready.swap(results);for(auto const& result:ready)pending.erase(result.player);}
        for(auto const& result:ready)level.forEachPlayer([&](Player& player){if(player.isPlayerInitialized() && stablePlayerKey(player)==result.player)player.sendMessage(result.text);return true;});
    }
    ~Impl(){ {std::lock_guard guard(lifetime);if(active==this)active=nullptr;} {std::lock_guard guard(mutex);stopping=true;}changed.notify_all();if(worker.joinable())worker.join(); }
};
ProjectCommands::ProjectCommands(EngineConfig const& config):impl_(std::make_unique<Impl>(config)){}
ProjectCommands::~ProjectCommands()=default;
void ProjectCommands::tick(Level& level){impl_->tick(level);}
}
