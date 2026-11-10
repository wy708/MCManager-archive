#pragma once
#include <filesystem>
#include <string>
#include <string_view>

namespace mcarchive {
std::string uuid();
std::string sha256(std::string_view bytes);
std::wstring widen(std::string_view text);
void atomicWrite(std::filesystem::path const& destination, std::string_view contents);
void durableRename(std::filesystem::path const& from, std::filesystem::path const& to);
std::string boundedRead(std::filesystem::path const& path, std::size_t maxBytes);
}
