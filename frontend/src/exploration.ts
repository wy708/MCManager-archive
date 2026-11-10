export interface Contribution {project:string;project_name:string;player:string;player_name:string;operation:string;block:string;value:number}
export interface Hotspot {day:string;dimension:string;x:number;z:number;metric:string;value:number}
export interface HeightCell {day:string;dimension:string;y:number;metric:string;value:number}
export interface RankRow {day:string;player:string;player_name:string;value:number}
export interface Exploration {
 generatedAt:string;from:string;to:string;zone:string;hours:{weekday:number;hour:number;millis:number}[];
 contributions:Contribution[];hotspots:Hotspot[];heights:HeightCell[];ranking:RankRow[];
 coverage:{recorded_events:number;recorded_blocks:number;positioned_blocks:number;retention_days:number;purge_before:string|null};notices:string[];
}

export interface PlayerActivity {player:string;name:string;online:number;placed:number;mined:number;planted:number;harvested:number;chat:number;travel:number}
export interface ExplorationDetails {
 generatedAt:string;from:string;to:string;zone:string;serverName:string;
 daily:{day:string;metric:string;amount:number}[];players:PlayerActivity[];
 runtime:{day:string;metric:string;samples:number;minimum:number;q1:number;median:number;q3:number;maximum:number}[];
 milestones:{kind:string;name:string;at:string;project?:string;revision:number}[];notices:string[];
}
