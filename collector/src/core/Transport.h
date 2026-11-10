#pragma once
#include "core/Outbox.h"
#include <string>
#include <memory>

namespace mcarchive {
struct ControlReply { unsigned status = 0; std::string body; std::string error; };
struct DeliveryResult {
    bool confirmed = false;
    unsigned status = 0;
    std::string error;
    std::size_t acceptedEvents = 0;
    std::size_t duplicateEvents = 0;
    bool duplicateBatch = false;
};
class HttpTransport {
public:
    HttpTransport(std::string endpoint, std::string token);
    ~HttpTransport();
    DeliveryResult deliver(PendingBatch const& batch) const;
    DeliveryResult deliverMany(std::vector<PendingBatch> const& batches) const;
    ControlReply postCommand(std::string const& route, std::string const& body) const;
private:
    std::string endpoint_;
    std::string token_;
    struct IngestConnection;
    std::unique_ptr<IngestConnection> ingest_;
    ControlReply postIngest(std::string const& body, bool bulk) const;
};
}
