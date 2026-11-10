#pragma once
#include <optional>
#include <string>
#include <string_view>
class Block;
namespace mcarchive {
std::optional<std::string> plantedCrop(std::string_view item, std::string_view before, Block const& after);
std::optional<std::string> matureCrop(Block const& block);
bool berryVine(std::string_view type);
}
