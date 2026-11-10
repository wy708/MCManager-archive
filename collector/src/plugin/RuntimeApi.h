#pragma once
// Keep legacy member-pointer linkage and signatures unchanged in the default build.
#if defined(MCARCHIVE_BDS_12661)
#define MCARCHIVE_NATIVE_SYMBOL(name, ...) ll::memory::SymbolView{name}
#define MCARCHIVE_FETCH_ENTITY fetchEntity
#define MCARCHIVE_INTERACT_HAND_PARAMETER , HandSlot handSlot
#define MCARCHIVE_INTERACT_HAND_ARGUMENT , handSlot
#define MCARCHIVE_DEATH_CAUSE(cause) std::string{deathCauseKey(cause)}
#else
#define MCARCHIVE_NATIVE_SYMBOL(name, ...) __VA_ARGS__
#define MCARCHIVE_FETCH_ENTITY $fetchEntity
#define MCARCHIVE_INTERACT_HAND_PARAMETER
#define MCARCHIVE_INTERACT_HAND_ARGUMENT
#define MCARCHIVE_DEATH_CAUSE(cause) ActorDamageSource::lookupCauseName(cause)
#endif
