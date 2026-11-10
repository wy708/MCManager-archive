#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>

namespace mcarchive {
enum class TravelMode { Walk, Swim, Fly, Glide, Vehicle };
inline constexpr std::array travelMetrics{"travel.walk_millimeters", "travel.swim_millimeters",
                                          "travel.fly_millimeters", "travel.glide_millimeters",
                                          "travel.vehicle_millimeters"};
inline constexpr char travelAlgorithm[] = "native-motion-sample-v1";
inline constexpr int defaultIdleSeconds = 300;
inline constexpr int minIdleSeconds = 30;
inline constexpr int maxIdleSeconds = 3600;
inline constexpr std::int64_t maxSampleGap = 750;

struct MotionPoint {
    double x, y, z;
    std::int64_t at;
    TravelMode mode;
    int dimension;
    std::int64_t carrier;
};

// Discontinuities return no segment. Stationary and tiny jitter return zero.
inline std::optional<std::int64_t> travelMillimeters(MotionPoint const &a, MotionPoint const &b) {
    auto elapsed = b.at - a.at;
    if (elapsed <= 0 || elapsed > maxSampleGap || a.mode != b.mode || a.dimension != b.dimension ||
        a.carrier != b.carrier)
        return {};
    auto dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    auto distance = std::hypot(dx, dy, dz);
    constexpr std::array<double, 5> speedLimits{18, 24, 100, 160, 100};
    if (!std::isfinite(distance) || distance > speedLimits[static_cast<unsigned>(b.mode)] * elapsed / 1000.0)
        return {};
    if (b.mode == TravelMode::Walk)
        distance = std::hypot(dx, dz);
    return distance < 0.02 ? 0 : std::llround(distance * 1000);
}
} // namespace mcarchive
