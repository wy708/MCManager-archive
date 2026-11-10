# Third-party notices

The root MIT license covers original MCManager Archive code only. It does not relicense upstream code, patches derived from upstream code, game resources, names or trademarks.

| Component | Source / terms | Where used |
| --- | --- | --- |
| MipMap | [Upstream](https://github.com/MipaSenpai/MipMap), MIT; [notice](licenses/MipMap-MIT.txt) | World map service and plugin patches |
| MiEx | [Upstream](https://github.com/BramStoutProductions/MiEx), BSD-3-Clause; [notice](licenses/MiEx-BSD-3-Clause.txt) | Scene conversion and derived patches |
| LeviLamina | [Upstream](https://github.com/LiteLDev/LeviLamina), upstream license | Native plugin SDK/runtime; version pins in collector |
| Endstone / LeviStone | [Endstone](https://github.com/EndstoneMC/endstone), upstream licenses | Map runtime adapter; pins in map/compatibility |
| cubiomes-bedrock | [Upstream](https://github.com/FragrantResult186/cubiomes-bedrock), MIT | Seed predictions; revision in terrain/sources.json |
| Minecraft resources | [bedrock-samples](https://github.com/Mojang/bedrock-samples), [Mojang notice](licenses/Mojang-bedrock-samples.md) | Block icons, names, textures and resources acquired during scene builds |
| Vue, ECharts, Three.js, Leaflet, Lucide and npm dependencies | Respective package licenses and lockfiles | Web UI; Leaflet/Three notices also in frontend/public/licenses |
| Spring Boot and Maven dependencies | Respective artifact licenses | Backend |

`frontend/public/project-icons/` contains game-resource-derived icons; these are **not MIT-licensed MCManager artwork**. Minecraft assets downloaded by scene builds remain governed by their original terms. Do not represent them as an unrestricted artwork pack.

Generated hero illustrations in `frontend/src/assets/` are presentation artwork, not live-server screenshots. Documentation screenshots use synthetic fixtures. Logos, names and trademarks retain their owners' rights.

The source release does not contain Minecraft server/client executables, worlds, player databases, platform credentials or a preconfigured DSH installation. Building optional components may download separately licensed tools/resources. Exact revisions and hashes are recorded in `scene/sources.json`, `terrain/sources.json`, `map/compatibility/sources.json` and collector runtime manifests. Retain upstream notices when redistributing derived components.
