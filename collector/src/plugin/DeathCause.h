#pragma once
#include "mc/deps/shared_types/legacy/actor/ActorDamageCause.h"
#include <string_view>
namespace mcarchive {
// Preserve the existing platform keys rather than lowercasing C++ enum names.
inline std::string_view deathCauseKey(SharedTypes::Legacy::ActorDamageCause cause) {
 using Cause=SharedTypes::Legacy::ActorDamageCause;
 switch(cause) {
 case Cause::None: return "none";
 case Cause::Override: return "override";
 case Cause::Contact: return "contact";
 case Cause::EntityAttack: return "entity_attack";
 case Cause::Projectile: return "projectile";
 case Cause::Suffocation: return "suffocation";
 case Cause::Fall: return "fall";
 case Cause::Fire: return "fire";
 case Cause::FireTick: return "fire_tick";
 case Cause::Lava: return "lava";
 case Cause::Drowning: return "drowning";
 case Cause::BlockExplosion: return "block_explosion";
 case Cause::EntityExplosion: return "entity_explosion";
 case Cause::Void: return "void";
 case Cause::SelfDestruct: return "self_destruct";
 case Cause::Magic: return "magic";
 case Cause::Wither: return "wither";
 case Cause::Starve: return "starve";
 case Cause::Anvil: return "anvil";
 case Cause::Thorns: return "thorns";
 case Cause::FallingBlock: return "falling_block";
 case Cause::Piston: return "piston";
 case Cause::FlyIntoWall: return "fly_into_wall";
 case Cause::Magma: return "magma";
 case Cause::Fireworks: return "fireworks";
 case Cause::Lightning: return "lightning";
 case Cause::Charging: return "charging";
 case Cause::Temperature: return "temperature";
 case Cause::Freezing: return "freezing";
 case Cause::Stalactite: return "stalactite";
 case Cause::Stalagmite: return "stalagmite";
 case Cause::RamAttack: return "ram_attack";
 case Cause::SonicBoom: return "sonic_boom";
 case Cause::Campfire: return "campfire";
 case Cause::SoulCampfire: return "soul_campfire";
 case Cause::MaceSmash: return "mace_smash";
 default: return "unknown";
 }
}
}
