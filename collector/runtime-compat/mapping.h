#pragma once
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace archive_compat {
constexpr size_t maxName = 4096;
constexpr size_t maxTable = 2 * 1024 * 1024;
enum class Kind { function, getter, direct };
struct Mapping { Kind kind; uint32_t rva; std::string name; };

inline std::vector<Mapping> parseTable(std::string_view input) {
    if (input.empty() || input.size() > maxTable || input.back() != '\n')
        throw std::runtime_error("missing, oversized or truncated table");
    std::vector<Mapping> result;
    std::unordered_set<std::string> names;
    while (!input.empty()) {
        const auto end = input.find('\n');
        auto line = input.substr(0, end);
        input.remove_prefix(end + 1);
        const auto first = line.find('\t');
        const auto second = line.find('\t', first == line.npos ? 0 : first + 1);
        if (first == line.npos || second == line.npos || line.find('\t', second + 1) != line.npos)
            throw std::runtime_error("invalid column count");
        const auto type = line.substr(0, first);
        const Kind kind = type == "function" ? Kind::function : type == "getter" ? Kind::getter
            : type == "direct" ? Kind::direct : throw std::runtime_error("invalid mapping kind");
        const auto hex = line.substr(first + 1, second - first - 1);
        if (hex.empty() || hex.size() > 8) throw std::runtime_error("invalid RVA");
        uint32_t rva = 0;
        for (const char c : hex) {
            const int digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
            if (digit < 0) throw std::runtime_error("invalid RVA digit");
            rva = (rva << 4) | static_cast<uint32_t>(digit);
        }
        const auto name = line.substr(second + 1);
        if (!rva || name.empty() || name.size() > maxName) throw std::runtime_error("invalid name or RVA");
        for (const unsigned char c : name)
            if (c < 32 || c > 126) throw std::runtime_error("invalid symbol bytes");
        if (!names.emplace(name).second) throw std::runtime_error("duplicate symbol");
        result.push_back({kind, rva, std::string(name)});
        if (result.size() > 10000) throw std::runtime_error("too many mappings");
    }
    return result;
}

inline void emitGetter(unsigned char* slot, uintptr_t address) noexcept {
    static_assert(sizeof(address) == 8, "x64 only");
    // Windows x64 pointer return in RAX; no arguments or stack modifications.
    std::memset(slot, 0xcc, 16);
    slot[0] = 0x48; slot[1] = 0xb8;
    std::memcpy(slot + 2, &address, 8);
    slot[10] = 0xc3;
}
}
