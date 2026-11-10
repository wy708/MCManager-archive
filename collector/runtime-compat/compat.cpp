#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <atomic>
#include <filesystem>
#include <limits>
#include <unordered_map>
#include "mapping.h"
#include "identity.generated.h"

namespace {
using namespace archive_compat;
std::unordered_map<std::string, uintptr_t> symbols;
std::atomic<bool> active{false};
std::atomic<unsigned long long> unresolved{0};
void* getterMemory = nullptr;
std::filesystem::path logPath;
struct File {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit File(std::filesystem::path const& path) : value(CreateFileW(path.c_str(), GENERIC_READ,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr)) {
        if (value == INVALID_HANDLE_VALUE) throw std::runtime_error("file open failed");
    }
    ~File() { CloseHandle(value); }
};
struct Hash {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE value = nullptr;
    Hash() {
        if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
            throw std::runtime_error("SHA256 unavailable");
        if (BCryptCreateHash(algorithm, &value, nullptr, 0, nullptr, 0, 0) < 0) {
            BCryptCloseAlgorithmProvider(algorithm, 0); algorithm = nullptr;
            throw std::runtime_error("SHA256 initialization failed");
        }
    }
    ~Hash() { if (value) BCryptDestroyHash(value); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
    void add(unsigned char* bytes, ULONG count) {
        if (BCryptHashData(value, bytes, count, 0) < 0) throw std::runtime_error("SHA256 read failed");
    }
    std::string finish() {
        unsigned char digest[32];
        if (BCryptFinishHash(value, digest, sizeof(digest), 0) < 0) throw std::runtime_error("SHA256 finish failed");
        constexpr char hex[] = "0123456789abcdef";
        std::string result; result.reserve(64);
        for (auto b : digest) { result += hex[b >> 4]; result += hex[b & 15]; }
        return result;
    }
};
std::string readAndHash(std::filesystem::path const& path, std::string* table = nullptr) {
    File file(path); Hash hash; std::array<unsigned char, 65536> buffer;
    for (;;) {
        DWORD count = 0;
        if (!ReadFile(file.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr))
            throw std::runtime_error("file read failed");
        if (!count) break;
        hash.add(buffer.data(), count);
        if (table) {
            if (table->size() + count > maxTable) throw std::runtime_error("table too large");
            table->append(reinterpret_cast<char*>(buffer.data()), count);
        }
    }
    return hash.finish();
}
std::filesystem::path modulePath(HMODULE module) {
    std::wstring buffer(32768, L'\0');
    const DWORD size = GetModuleFileNameW(module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!size || size >= buffer.size()) throw std::runtime_error("module path unavailable");
    buffer.resize(size); return buffer;
}
void log(char const* message) noexcept {
    try {
        OutputDebugStringA(message);
        if (logPath.empty()) return;
        HANDLE file = CreateFileW(logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return;
        DWORD written;
        WriteFile(file, message, static_cast<DWORD>(std::strlen(message)), &written, nullptr);
        WriteFile(file, "\r\n", 2, &written, nullptr); CloseHandle(file);
    } catch (...) {} // Diagnostics cannot escape a loader or resolver boundary.
}
void require(bool condition, char const* message) { if (!condition) throw std::runtime_error(message); }
bool validSection(uintptr_t base, Mapping const& row) {
    auto dos = reinterpret_cast<IMAGE_DOS_HEADER const*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 4096) return false;
    auto nt = reinterpret_cast<IMAGE_NT_HEADERS64 const*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64
        || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC || row.rva >= nt->OptionalHeader.SizeOfImage)
        return false;
    auto section = IMAGE_FIRST_SECTION(nt);
    for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; ++i) {
        auto const& s = section[i];
        if (row.rva < s.VirtualAddress || uint64_t(row.rva) >= uint64_t(s.VirtualAddress) + s.Misc.VirtualSize) continue;
        bool executable = (s.Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
        return row.kind == Kind::function ? executable : !executable && (s.Characteristics & IMAGE_SCN_MEM_READ);
    }
    return false;
}
void* lookup(char const* name, size_t size) noexcept {
    try {
        if (!name || !size || size > maxName) return nullptr;
        auto found = symbols.find(std::string(name, size));
        if (found != symbols.end()) return reinterpret_cast<void*>(found->second);
        unresolved.fetch_add(1, std::memory_order_relaxed);
        return nullptr; // An old resolver may return a plausible but wrong address. Never fall back.
    } catch (...) { return nullptr; }
}
void* __cdecl resolveN(char const* name, size_t size) noexcept { return lookup(name, size); }
void* __cdecl resolveSilentN(char const* name, size_t size) noexcept { return lookup(name, size); }
void* __cdecl resolve(char const* name) noexcept {
    if (!name) return nullptr;
    size_t size = 0;
    while (size <= maxName && name[size]) ++size;
    return lookup(name, size);
}
void* __cdecl resolveSilent(char const* name) noexcept { return resolve(name); }
using Hook = int(__cdecl*)(void*, void*, void**, int);
using Unhook = bool(__cdecl*)(void*, void*);
struct HookTransaction {
    struct Entry { char const* name; void* replacement; void* target = nullptr; void* original = nullptr; };
    Entry entries[4] = {
        {"pl_resolve_symbol_silent_n", reinterpret_cast<void*>(&resolveSilentN)},
        {"pl_resolve_symbol_n", reinterpret_cast<void*>(&resolveN)},
        {"pl_resolve_symbol_silent", reinterpret_cast<void*>(&resolveSilent)},
        {"pl_resolve_symbol", reinterpret_cast<void*>(&resolve)}
    };
    Unhook unhook = nullptr;
    size_t installed = 0;
    bool committed = false;
    ~HookTransaction() noexcept {
        if (committed) return;
        while (installed) {
            auto& entry = entries[--installed];
            bool okay = false;
            try { okay = unhook(entry.target, entry.replacement); } catch (...) {}
            if (!okay) {
                log("FATAL: resolver hook rollback failed; terminating to prevent unsafe execution");
                TerminateProcess(GetCurrentProcess(), 87);
                __fastfail(7);
            }
        }
    }
};
void initialize(HINSTANCE self) {
    const auto directory = modulePath(self).parent_path();
    logPath = directory / L"runtime-compat.log";
    log("Loading exact-build runtime compatibility layer");
    const auto executable = modulePath(nullptr);
    require(readAndHash(executable) == identity::executableSHA, "REFUSED: loaded executable hash mismatch");
    auto preloader = GetModuleHandleW(L"PreLoader.dll");
    require(preloader != nullptr, "REFUSED: PreLoader not loaded");
    require(readAndHash(modulePath(preloader)) == identity::preloaderSHA, "REFUSED: PreLoader hash mismatch");
    const auto llModule = GetModuleHandleW(L"LeviLamina.dll");
    const auto llPath = llModule ? modulePath(llModule) : executable.parent_path() / L"plugins" / L"LeviLamina" / L"LeviLamina.dll";
    require(readAndHash(llPath) == identity::leviLaminaSHA, "REFUSED: LeviLamina hash mismatch");
    std::string table;
    require(readAndHash(directory / L"compat-symbols.tsv", &table) == identity::tableSHA,
        "REFUSED: symbol table hash mismatch");
    const auto mappings = parseTable(table);
    require(mappings.size() == identity::symbolCount, "REFUSED: symbol count mismatch");
    const auto base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
    symbols.reserve(mappings.size());
    size_t getters = 0;
    for (auto const& row : mappings) {
        require(validSection(base, row), "REFUSED: symbol target section mismatch");
        if (row.kind == Kind::getter) ++getters;
    }
    if (getters) {
        getterMemory = VirtualAlloc(nullptr, getters * 16, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        require(getterMemory != nullptr, "REFUSED: getter allocation failed");
    }
    size_t used = 0;
    for (auto const& row : mappings) {
        uintptr_t address = base + row.rva;
        if (row.kind == Kind::getter) {
            auto slot = static_cast<unsigned char*>(getterMemory) + used;
            emitGetter(slot, address); used += 16;
            address = reinterpret_cast<uintptr_t>(slot);
        }
        require(symbols.emplace(row.name, address).second, "REFUSED: duplicate symbol");
    }
    if (getters) {
        DWORD old;
        require(VirtualProtect(getterMemory, getters * 16, PAGE_EXECUTE_READ, &old) != 0,
            "REFUSED: getter executable protection failed");
        require(FlushInstructionCache(GetCurrentProcess(), getterMemory, getters * 16) != 0,
            "REFUSED: getter instruction cache flush failed");
    }
    HookTransaction transaction;
    auto hook = reinterpret_cast<Hook>(GetProcAddress(preloader, "pl_hook"));
    transaction.unhook = reinterpret_cast<Unhook>(GetProcAddress(preloader, "pl_unhook"));
    require(hook && transaction.unhook, "REFUSED: hook API unavailable");
    for (auto& entry : transaction.entries) {
        entry.target = reinterpret_cast<void*>(GetProcAddress(preloader, entry.name));
        require(entry.target != nullptr, "REFUSED: resolver export unavailable");
    }
    // Hooks reference this DLL for process lifetime. Pin before publishing any function pointer.
    HMODULE pinned = nullptr;
    require(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(self), &pinned) != 0, "REFUSED: cannot pin compatibility module");
    for (auto& entry : transaction.entries) {
        require(hook(entry.target, entry.replacement, &entry.original, 0) == 0, "REFUSED: resolver hook failed");
        ++transaction.installed;
    }
    transaction.committed = true;
    active.store(true, std::memory_order_release);
    log("ACTIVE: verified mappings only; gameplay validation remains separate");
}
}

extern "C" __declspec(dllexport) char const* __cdecl mcarchive_runtime_compat_target() noexcept {
    return active.load(std::memory_order_acquire) ? identity::target : nullptr;
}
extern "C" __declspec(dllexport) unsigned long long __cdecl mcarchive_runtime_compat_unresolved_count() noexcept {
    return unresolved.load(std::memory_order_relaxed);
}
extern "C" __declspec(dllexport) unsigned int __cdecl mcarchive_runtime_compat_symbol_count() noexcept {
    return active.load(std::memory_order_acquire) ? identity::symbolCount : 0;
}
BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID) noexcept {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    // Keep thread notifications enabled: the independent bundle links the static CRT.
    try { initialize(self); return TRUE; }
    catch (std::exception const& error) { log(error.what()); }
    catch (...) { log("REFUSED: unexpected compatibility initialization exception"); }
    active.store(false, std::memory_order_release);
    symbols.clear();
    if (getterMemory) { VirtualFree(getterMemory, 0, MEM_RELEASE); getterMemory = nullptr; }
    return FALSE;
}
