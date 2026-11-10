set_project("MCManagerArchiveCollector")
set_version("0.38.0")
set_xmakever("3.0.0")
add_rules("mode.debug", "mode.release")
set_languages("c++20")
set_runtimes("MD")
set_toolchains("msvc")
add_requires("nlohmann_json v3.12.0")

option("native")
    set_default(false)
    set_showmenu(true)
    set_description("Build the native plugin for the selected exact runtime")
option_end()

option("runtime")
    set_default("1.26.51.1")
    set_values("1.26.51.1", "1.26.61.1")
    set_showmenu(true)
    set_description("Exact BDS runtime build profile; default retains LeviLamina 26.51.8")
option_end()

local runtime = get_config("runtime") or "1.26.51.1"

local modern = runtime == "1.26.61.1"
local loader = modern and "26.60.2" or "26.51.8"
-- Separate new artifacts and objects; preserve existing default build paths.
if modern then
    set_targetdir("build/1.26.61.1/$(plat)/$(arch)/$(mode)")
    set_objectdir("build/.objs-1.26.61.1")
    add_defines("MCARCHIVE_BDS_12661=1")
end

if has_config("native") then
    add_repositories("archive-levimc " .. path.join(os.projectdir(), modern and "../.tools/levimc-xmake-repo-26.60.2" or "../.tools/levimc-xmake-repo"))
    add_requires("levibuildscript 0.6.2", modern and "bedrockdata v26.60.6-server.8" or "bedrockdata v26.51.1-server.11")
    -- Both profiles pin their SDK and bedrockdata rather than using a cached arbitrary release.
    add_requires("entt v4.0.0", "expected-lite v0.8.0", "fmt 11.2.0", "gsl v4.2.0", "glm 1.0.1")
    add_requires("leveldb 1.23", "magic_enum v0.9.7", "rapidjson 2025.02.05", "type_safe v0.2.4")
    add_requires("pcg_cpp v1.0.0", "pfr 2.1.1", "symbolprovider v1.3.0")
    add_requires("parallel-hashmap v2.0.0", "concurrentqueue v1.0.4", "stb 2025.03.14", "zlib v1.3.2")
end

target("archive-collector-core")
    set_kind("static")
    add_packages("nlohmann_json", {public = true})
    add_includedirs("src", {public = true})
    add_defines("NOMINMAX", "WIN32_LEAN_AND_MEAN", "UNICODE", {public = true})
    add_cxflags("/EHsc", "/utf-8", "/W4")
    add_files("src/core/**.cpp")
    add_syslinks("bcrypt", "winhttp", "psapi", "iphlpapi", {public = true})

target("verify-collector-core")
    set_kind("binary")
    add_deps("archive-collector-core")
    add_cxflags("/EHsc", "/utf-8", "/W4")
    add_files("tests/core.cpp")

target("verify-ai-mailbox")
    set_kind("binary")
    set_default(false)
    add_deps("archive-collector-core")
    add_cxflags("/EHsc", "/utf-8", "/W4")
    add_files("tests/ai.cpp")

if has_config("native") then
local function nativeTarget(name, version)
target(name)
    set_kind("shared")
    set_toolchains("clang-cl")
    set_symbols("debug")
    -- Keep developer home directories out of distributed PE debug records.
    add_shflags("/PDBALTPATH:" .. name .. ".pdb", {force = true})
    set_exceptions("none")
    add_rules("@levibuildscript/linkrule")
    if modern then
        -- Upstream modpacker has a shared bin path. Keep this exact runtime's
        -- package separate so switching profiles cannot overwrite either DLL.
        after_build(function(target)
            import("core.base.json")
            local output = path.join(os.projectdir(), "bin", runtime, target:name())
            os.mkdir(output)
            os.cp(target:targetfile(), output)
            local pdb = path.join(path.directory(target:targetfile()), target:name() .. ".pdb")
            if os.isfile(pdb) then os.cp(pdb, output) end
            json.savefile(path.join(output, "manifest.json"), {
                name = target:name(), entry = path.filename(target:targetfile()),
                version = version, type = "native", platform = "server"
            })
        end)
    else
        add_rules("@levibuildscript/modpacker", {modVersion = version, modPlatform = "server"})
    end
    add_defines("_HAS_CXX23=1", "LL_PLAT_S", "ENTT_PACKED_PAGE=128", "ENTT_SPARSE_PAGE=4096", "FMT_USE_FULL_CACHE_DRAGONBOX=1")
    add_cxflags("/EHa", "/EHs", "/utf-8", "/W4", "-Wno-microsoft-cast", "-Wno-invalid-offsetof", "-Wno-c++2b-extensions", "-Wno-microsoft-include", "-Wno-overloaded-virtual", "-Wno-ignored-qualifiers", "-Wno-missing-field-initializers", "-Wno-potentially-evaluated-expression", "-Wno-pragma-system-header-outside-header", {tools = {"clang_cl"}})
    add_packages("bedrockdata", "entt", "expected-lite", "fmt", "gsl", "glm", "leveldb", "magic_enum", "rapidjson", "type_safe", "pcg_cpp", "pfr", "symbolprovider", "parallel-hashmap", "concurrentqueue", "stb", "zlib")
    local sdk = path.join(os.projectdir(), "../.tools/collector-sdk-" .. loader)
    add_includedirs(path.join(sdk, "include"))
    add_linkdirs(path.join(sdk, "lib"))
    add_links("LeviLamina")
    on_load(function(target)
        assert(os.isfile(path.join(sdk, "provenance.json")), "Run node ../scripts/prepare-collector-sdk.mjs before building the native target")
    end)
end
nativeTarget("archive-collector", "0.38.0")
    add_deps("archive-collector-core")
    add_files("src/plugin/*.cpp")
    if modern then
        remove_files("src/plugin/CraftTracker.cpp")
        add_files("src/plugin/compat/CraftTracker12661.cpp")
    end
if not modern then
nativeTarget("archive-qa-guards", "0.15.0")
    set_default(false)
    add_files("qa/Guards.cpp", "src/plugin/MemoryOperators.cpp")
else
nativeTarget("archive-port-craft-qa", "0.1.0")
    set_default(false)
    add_files("qa/CraftPortGuards.cpp", "src/plugin/MemoryOperators.cpp")
end
end
