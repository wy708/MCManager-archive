#pragma once
namespace mcarchive::runtime {
#if defined(MCARCHIVE_BDS_12661)
inline constexpr char bdsVersion[] = "1.26.61.1";
inline constexpr char loaderVersion[] = "26.60.2";
inline constexpr char craftingAlgorithm[] = "native-crafting-commit-v2";
inline constexpr char tradeAlgorithm[] = "native-trade-commit-v2";
#else
inline constexpr char bdsVersion[] = "1.26.51.1";
inline constexpr char loaderVersion[] = "26.51.8";
inline constexpr char craftingAlgorithm[] = "native-crafting-commit-v1";
inline constexpr char tradeAlgorithm[] = "native-trade-commit-v1";
#endif
}
