#include "core/Transport.h"
#include "core/Platform.h"
#include <Windows.h>
#include <winhttp.h>
#include <nlohmann/json.hpp>
#include <array>
#include <regex>
#include <stdexcept>

namespace mcarchive {
namespace {
struct InternetHandle {
    HINTERNET value = nullptr;
    void reset() { if (value) WinHttpCloseHandle(value); value = nullptr; }
    ~InternetHandle() { reset(); }
};
DeliveryResult networkFailure(char const* operation) {
    return {false, 0, std::string(operation) + " failed (Windows " + std::to_string(GetLastError()) + ")"};
}
}
struct HttpTransport::IngestConnection {
    std::mutex mutex;
    InternetHandle session, connection;
    void reset() { connection.reset(); session.reset(); }
};
HttpTransport::HttpTransport(std::string endpoint, std::string token) : endpoint_(std::move(endpoint)), token_(std::move(token)) {
    if (!std::regex_match(token_, std::regex("[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}"))) throw std::runtime_error("Invalid collector token format");
    if (endpoint_.size() > 2048 || endpoint_.find_first_of("\r\n") != std::string::npos || !endpoint_.ends_with("/api/ingest/v1/batches")) throw std::runtime_error("Collector endpoint must end with /api/ingest/v1/batches");
    auto wide = widen(endpoint_);
    URL_COMPONENTS url{}; url.dwStructSize = sizeof(url); url.dwSchemeLength = url.dwHostNameLength = url.dwUrlPathLength = url.dwUserNameLength = url.dwPasswordLength = url.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &url)
        || (url.nScheme != INTERNET_SCHEME_HTTP && url.nScheme != INTERNET_SCHEME_HTTPS)
        || url.dwHostNameLength == 0 || url.dwUserNameLength || url.dwPasswordLength || url.dwExtraInfoLength) throw std::runtime_error("Invalid collector endpoint URL");
    ingest_ = std::make_unique<IngestConnection>();
}

HttpTransport::~HttpTransport() = default;
ControlReply HttpTransport::postIngest(std::string const& body, bool bulk) const {
    std::lock_guard lock(ingest_->mutex);
    auto failure = [&](char const* operation) {
        auto result = networkFailure(operation); ingest_->reset();
        return ControlReply{result.status, {}, result.error};
    };
    auto wide = widen(endpoint_);
    URL_COMPONENTS url{}; url.dwStructSize = sizeof(url); url.dwSchemeLength = url.dwHostNameLength = url.dwUrlPathLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &url)) return failure("Parse endpoint");
    std::wstring host(url.lpszHostName, url.dwHostNameLength), path(url.lpszUrlPath, url.dwUrlPathLength);
    if (bulk) path += L"/bulk";
    if (!ingest_->session.value) {
        auto local = host == L"127.0.0.1" || host == L"localhost" || host == L"[::1]" || host == L"::1";
        ingest_->session.value = WinHttpOpen(L"MCManagerArchiveCollector/0.36.0", local ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!ingest_->session.value) return failure("Open HTTP session");
        if (!WinHttpSetTimeouts(ingest_->session.value, 5000, 5000, 10000, 35000)) return failure("Configure timeouts");
        ingest_->connection.value = WinHttpConnect(ingest_->session.value, host.c_str(), url.nPort, 0);
        if (!ingest_->connection.value) return failure("Connect");
    }
    InternetHandle request{WinHttpOpenRequest(ingest_->connection.value, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, url.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)};
    if (!request.value) return failure("Create upload request");
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect))) return failure("Disable redirects");
    auto headers = L"Content-Type: application/json\r\nAuthorization: Bearer " + widen(token_) + L"\r\n";
    if (!WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()), const_cast<char*>(body.data()), static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0)) return failure("Send batch");
    if (!WinHttpReceiveResponse(request.value, nullptr)) return failure("Receive batch response");
    DWORD status = 0, size = sizeof(status);
    if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) return failure("Read HTTP status");
    if (status != 200) { ingest_->reset(); return {status, {}, "Upload rejected; pending bytes preserved"}; }
    std::string response;
    std::array<char, 4096> buffer{};
    for (;;) {
        DWORD count = 0;
        if (!WinHttpReadData(request.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count)) return failure("Read acknowledgement");
        if (!count) break;
        response.append(buffer.data(), count);
        if (response.size() > 65536) { ingest_->reset(); return {status, {}, "Acknowledgement exceeds size limit"}; }
    }
    return {status, std::move(response), {}};
}
namespace {
DeliveryResult validateReceipt(nlohmann::json const& receipt, PendingBatch const& batch) {
    constexpr unsigned status = 200;
    if (!receipt.is_object() || receipt.value("batchId", std::string()) != batch.batchId
        || !receipt.contains("acceptedEvents") || !receipt["acceptedEvents"].is_number_integer()
        || !receipt.contains("duplicateEvents") || !receipt["duplicateEvents"].is_number_integer()
        || !receipt.contains("duplicateBatch") || !receipt["duplicateBatch"].is_boolean()) return {false, status, "Acknowledgement shape or batch ID does not match"};
    auto accepted = receipt["acceptedEvents"].get<long long>(), duplicate = receipt["duplicateEvents"].get<long long>();
    if (accepted < 0 || duplicate < 0 || accepted > 1000 || duplicate > 1000
        || static_cast<unsigned long long>(accepted + duplicate) != batch.eventCount) return {false, status, "Acknowledgement counts do not match the stored batch"};
    if (receipt["duplicateBatch"].get<bool>() && accepted != 0) return {false, status, "Duplicate batch receipt contains newly accepted events"};
    return {true, status, {}, static_cast<std::size_t>(accepted), static_cast<std::size_t>(duplicate), receipt["duplicateBatch"].get<bool>()};
}
}
DeliveryResult HttpTransport::deliver(PendingBatch const& batch) const {
    if (batch.serverId != token_.substr(0, 36)) return {false, 0, "Credential belongs to another server archive; no request sent"};
    if (batch.body.size() > 1'048'576) return {false, 0, "Batch exceeds protocol size limit"};
    auto response = postIngest(batch.body, false);
    if (!response.error.empty()) return {false, response.status, response.error};
    try { return validateReceipt(nlohmann::json::parse(response.body), batch); }
    catch (std::exception const&) { return {false, response.status, "Invalid JSON acknowledgement; pending bytes preserved"}; }
}
DeliveryResult HttpTransport::deliverMany(std::vector<PendingBatch> const& batches) const {
    if (batches.empty() || batches.size() > 16) return {false, 0, "Invalid bulk batch count"};
    if (batches.size() == 1) return deliver(batches.front());
    nlohmann::json bodies = nlohmann::json::array(); std::size_t events = 0;
    for (auto const& batch : batches) {
        if (batch.serverId != token_.substr(0, 36) || batch.body.size() > 1'048'576) return {false, 0, "Invalid bulk batch ownership or size"};
        bodies.push_back(batch.body); events += batch.eventCount;
    }
    auto body = nlohmann::json{{"batches", bodies}}.dump();
    if (body.size() > 1'048'576 || events > 512) return {false, 0, "Bulk batch exceeds protocol limit"};
    auto response = postIngest(body, true);
    if (!response.error.empty()) return {false, response.status, response.error};
    try {
        auto receipts = nlohmann::json::parse(response.body);
        if (!receipts.is_array() || receipts.size() != batches.size()) return {false, 200, "Bulk acknowledgement count mismatch"};
        DeliveryResult total{true, 200, {}, 0, 0, true};
        for (std::size_t i = 0; i < batches.size(); ++i) {
            auto receipt = validateReceipt(receipts[i], batches[i]);
            if (!receipt.confirmed) return receipt;
            total.acceptedEvents += receipt.acceptedEvents; total.duplicateEvents += receipt.duplicateEvents;
            total.duplicateBatch = total.duplicateBatch && receipt.duplicateBatch;
        }
        return total;
    } catch (std::exception const&) { return {false, 200, "Invalid bulk acknowledgement; all original files retained"}; }
}
ControlReply HttpTransport::postCommand(std::string const& route, std::string const& body) const {
    static std::regex const allowed("/(commands/(claim|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(begin|ack))|qq-binding-codes|projects|project-models/(plan|capture)|world-queries/(claim|player-snapshots|[0-9a-f-]{36}/complete))");
    if (!std::regex_match(route, allowed) || body.size() > (route=="/project-models/capture"?1048576:65536)) return {0, {}, "Invalid collector control request"};
    auto fail = [] { return ControlReply{0, {}, "Collector control HTTP failed (Windows " + std::to_string(GetLastError()) + ")"}; };
    auto wide = widen(endpoint_.substr(0, endpoint_.size() - std::string("/batches").size()) + route);
    URL_COMPONENTS url{}; url.dwStructSize = sizeof(url); url.dwSchemeLength = url.dwHostNameLength = url.dwUrlPathLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &url)) return fail();
    std::wstring host(url.lpszHostName, url.dwHostNameLength), path(url.lpszUrlPath, url.dwUrlPathLength);
    auto local = host == L"127.0.0.1" || host == L"localhost" || host == L"[::1]" || host == L"::1";
    InternetHandle session{WinHttpOpen(L"MCManagerArchiveCollector/0.16.0", local ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.value || !WinHttpSetTimeouts(session.value, 5000, 5000, 10000, 35000)) return fail();
    InternetHandle connection{WinHttpConnect(session.value, host.c_str(), url.nPort, 0)}; if (!connection.value) return fail();
    InternetHandle request{WinHttpOpenRequest(connection.value, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, url.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)};
    if (!request.value) return fail();
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect))) return fail();
    auto headers = L"Content-Type: application/json\r\nAuthorization: Bearer " + widen(token_) + L"\r\n";
    if (!WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()), const_cast<char*>(body.data()), static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0)
        || !WinHttpReceiveResponse(request.value, nullptr)) return fail();
    DWORD status = 0, size = sizeof(status);
    if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) return fail();
    if (status != 200) return {status, {}, "Collector control request rejected"};
    std::string result; std::array<char, 4096> buffer{};
    for (;;) {
        DWORD count = 0; if (!WinHttpReadData(request.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count)) return fail(); if (!count) break;
        result.append(buffer.data(), count); if (result.size() > 65536) return {status, {}, "Collector control response exceeds size limit"};
    }
    return {status, std::move(result), {}};
}
}
