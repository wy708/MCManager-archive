#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fstream>
#include <filesystem>
#include <iostream>
#include <iterator>
#include "mapping.h"
#include "identity.generated.h"
using namespace archive_compat;
void check(bool okay, char const* message) { if (!okay) throw std::runtime_error(message); }
int wmain(int argc, wchar_t** argv) {
    try {
        check(argc == 3, "expected table and DLL paths");
        std::ifstream input(argv[1], std::ios::binary);
        std::string text((std::istreambuf_iterator<char>(input)), {});
        auto table = parseTable(text);
        check(table.size() == identity::symbolCount, "canonical symbol count");
        for (const std::string bad : {
            "", "function\t123\tfoo", "function\t0\tfoo\n", "function\t100000000\tfoo\n",
            "function\t12junk\tfoo\n", "function\t+123\tfoo\n", "other\t123\tfoo\n",
            "getter\t123\t\n", "direct\t123\tfoo\textra\n", "direct\t123\tfoo\r\n",
            "function\t123\tfoo\ngetter\t456\tfoo\n", "function\t123\tfoo\n\n"
        }) {
            bool rejected = false;
            try { (void)parseTable(bad); } catch (std::runtime_error const&) { rejected = true; }
            check(rejected, "malformed table accepted");
        }
        std::string embedded = "function\t123\tfoo"; embedded.push_back('\0'); embedded += "bar\n";
        bool rejected = false;
        try { (void)parseTable(embedded); } catch (...) { rejected = true; }
        check(rejected, "embedded null accepted");
        auto slot = static_cast<unsigned char*>(VirtualAlloc(nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        check(slot != nullptr, "getter allocation");
        int sentinel = 42;
        emitGetter(slot, reinterpret_cast<uintptr_t>(&sentinel));
        DWORD old;
        check(VirtualProtect(slot, 4096, PAGE_EXECUTE_READ, &old) != 0, "getter protection");
        check(FlushInstructionCache(GetCurrentProcess(), slot, 16) != 0, "getter cache");
        check(reinterpret_cast<int*(__cdecl*)()>(slot)() == &sentinel, "getter returns actual data address");
        VirtualFree(slot, 0, MEM_RELEASE);
        // An unrelated host must be refused before hooks or symbol publication.
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
        auto dll = LoadLibraryW(argv[2]);
        check(dll == nullptr, "DLL accepted an unsupported host executable");
        std::ifstream log(std::filesystem::path(argv[2]).parent_path() / L"runtime-compat.log");
        std::string diagnostic((std::istreambuf_iterator<char>(log)), {});
        check(diagnostic.find("REFUSED: loaded executable hash mismatch") != std::string::npos,
            "DLL refusal was not caused by the expected identity check");
        std::cout << "PASS: canonical 932 symbols, malformed/truncated/duplicate tables, getter ABI, unsupported-host refusal\n";
        return 0;
    } catch (std::exception const& error) { std::cerr << error.what() << '\n'; return 1; }
}
