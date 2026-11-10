#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

namespace mcarchive {
struct ActionInterval { std::int64_t at; std::int64_t millis; };
// A minute boundary also contains every current timezone's day boundary. The
// event belongs to the last included millisecond, never to the next interval.
inline std::vector<ActionInterval> actionIntervals(std::int64_t start, std::int64_t elapsed) {
    if (start < 0 || elapsed < 0 || elapsed > std::numeric_limits<std::int64_t>::max() - start)
        throw std::runtime_error("Invalid measured action interval");
    std::vector<ActionInterval> result;
    while (elapsed > 0) {
        auto part = std::min(elapsed, 60'000 - start % 60'000);
        result.push_back({start + part - 1, part}); start += part; elapsed -= part;
    }
    return result;
}
}
