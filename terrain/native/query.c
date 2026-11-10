/* A bounded, offline biome sampler. No game process, network, or world files. */
#include "generator.h"
#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <errno.h>
#include <string.h>

static int64_t number(const char *s, int64_t low, int64_t high) {
    char *end; errno = 0;
    int64_t value = strtoll(s, &end, 10);
    if (!*s || *end || errno || value < low || value > high) exit(2);
    return value;
}
static int quart(int coordinate) { return coordinate>=0?coordinate/4:(coordinate-3)/4; }
#include "structures.h"
int main(void) {
    /* Seed stays off the process command line. Exactly eight bounded tokens. */
    char profile[32], seedText[32], dimension[24], sx[24], sy[24], sz[24], sr[24], ss[24], extra[2];
    if (scanf("%31s",profile)!=1) return 2;
    if (!strcmp(profile,"structures")) return queryStructures();
    if (!strcmp(profile,"chunks")) return queryChunks();
    if (scanf("%31s %23s %23s %23s %23s %23s %23s",seedText,dimension,sx,sy,sz,sr,ss)!=7) return 2;
    if (scanf("%1s", extra)==1) return 2;
    int version;
    if (!strcmp(profile,"bedrock-26.60")) version=MC_26_60;
    else if (!strcmp(profile,"bedrock-26.50")) version=MC_26_50;
    else return 2;
    int dim;
    if (!strcmp(dimension,"overworld")) dim=DIM_OVERWORLD;
    else if (!strcmp(dimension,"nether")) dim=DIM_NETHER;
    else return 2;
    uint64_t seed=(uint64_t)number(seedText,INT64_MIN,INT64_MAX);
    int x=(int)number(sx,-30000000,30000000), z=(int)number(sz,-30000000,30000000);
    int y=(int)number(sy,dim==DIM_OVERWORLD?-64:0,dim==DIM_OVERWORLD?319:127);
    int radius=(int)number(sr,0,128), step=(int)number(ss,16,64);
    if (radius%step || (step!=16 && step!=32 && step!=64) || abs(x)>30000000-radius || abs(z)>30000000-radius) return 2;
    Generator g; setupGenerator(&g,version,0); applySeed(&g,dim,seed);
    printf("{\"engine\":\"cubiomes-bedrock-294c72ab-mcarchive1\",\"profile\":\"%s\",\"samples\":[",profile);
    int first=1;
    for(int dz=-radius;dz<=radius;dz+=step) for(int dx=-radius;dx<=radius;dx+=step) {
        /* BDS Dimension.getBiome reads the 4-block biome lattice. The library's
           scale=1 Voronoi smoothing disagrees at boundaries in actual BDS.
           Floor division is explicit so negative block coordinates stay correct. */
        int id=getBiomeAt(&g,4,quart(x+dx),quart(y),quart(z+dz));
        const char *name=biome2str(version,id);
        /* This pinned fork declares these IDs but omits their util.c labels. */
        if(id==grove) name="grove";
        else if(id==snowy_slopes) name="snowy_slopes";
        else if(id==jagged_peaks) name="jagged_peaks";
        else if(id==frozen_peaks) name="frozen_peaks";
        if(id<0) return 3;
        if(!name) name="unknown";
        if(!first) putchar(','); first=0;
        printf("{\"x\":%d,\"y\":%d,\"z\":%d,\"biomeId\":%d,\"biome\":\"%s\"}",x+dx,y,z+dz,id,name);
    }
    puts("]}"); return 0;
}
