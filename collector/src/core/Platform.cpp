#include "core/Platform.h"
#include <Windows.h>
#include <bcrypt.h>
#include <array>
#include <algorithm>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace mcarchive {
namespace {
struct FileHandle {
    HANDLE value = INVALID_HANDLE_VALUE;
    ~FileHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::runtime_error failure(char const* operation) {
    return std::runtime_error(std::string(operation) + " failed (Windows " + std::to_string(GetLastError()) + ")");
}
std::string hex(unsigned char const* data, std::size_t size) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string output(size * 2, '0');
    for (std::size_t i = 0; i < size; ++i) { output[i * 2] = digits[data[i] >> 4]; output[i * 2 + 1] = digits[data[i] & 15]; }
    return output;
}
}
std::wstring widen(std::string_view text) {
    if (text.empty()) return {};
    if (text.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) throw std::runtime_error("UTF-8 input too large");
    auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (length <= 0) throw failure("UTF-8 conversion");
    std::wstring output(static_cast<std::size_t>(length), L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), output.data(), length)) throw failure("UTF-8 conversion");
    return output;
}
std::string uuid() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) throw std::runtime_error("Random source unavailable");
    bytes[6] = static_cast<unsigned char>((bytes[6] & 15) | 64);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 63) | 128);
    auto value = hex(bytes.data(), bytes.size());
    return value.substr(0, 8) + "-" + value.substr(8, 4) + "-" + value.substr(12, 4) + "-" + value.substr(16, 4) + "-" + value.substr(20);
}
std::string sha256(std::string_view bytes) {
    if (bytes.size() > std::numeric_limits<ULONG>::max()) throw std::runtime_error("Hash input too large");
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw std::runtime_error("SHA-256 provider unavailable");
    std::array<unsigned char, 32> digest{};
    auto status = BCryptHash(algorithm, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) throw std::runtime_error("SHA-256 failed");
    return hex(digest.data(), digest.size());
}
void durableRename(std::filesystem::path const& from, std::filesystem::path const& to) {
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH)) throw failure("Atomic outbox rename");
}
void atomicWrite(std::filesystem::path const& destination, std::string_view contents) {
    auto temporary = destination; temporary += L".writing";
    FileHandle file{CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr)};
    if (file.value == INVALID_HANDLE_VALUE) throw failure("Outbox create");
    std::size_t offset = 0;
    while (offset < contents.size()) {
        DWORD written = 0;
        auto count = static_cast<DWORD>(std::min<std::size_t>(contents.size() - offset, 1 << 20));
        if (!WriteFile(file.value, contents.data() + offset, count, &written, nullptr) || written == 0) throw failure("Outbox write");
        offset += written;
    }
    if (!FlushFileBuffers(file.value)) throw failure("Outbox flush");
    CloseHandle(file.value); file.value = INVALID_HANDLE_VALUE;
    durableRename(temporary, destination);
}
std::string boundedRead(std::filesystem::path const& path, std::size_t maxBytes) {
    auto attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) throw std::runtime_error("Outbox entry is missing or is not a regular file");
    if (std::filesystem::file_size(path) > maxBytes) throw std::runtime_error("Outbox entry exceeds its size limit");
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read outbox entry");
    std::string contents;
    std::array<char, 8192> chunk{};
    while (input) {
        input.read(chunk.data(), chunk.size());
        contents.append(chunk.data(), static_cast<std::size_t>(input.gcount()));
        if (contents.size() > maxBytes) throw std::runtime_error("Outbox entry grew beyond its size limit");
    }
    if (!input.eof()) throw std::runtime_error("Outbox read failed");
    return contents;
}
}
