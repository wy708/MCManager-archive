/* Bounded structure candidates: region placement plus upstream biome checks.
 * This does not read generated chunks or prove a structure currently exists. */
#include "finders.h"

typedef struct { const char *name; int type; int dim; } ArchiveStructure;
static const ArchiveStructure archiveStructures[] = {
    {"village",Village,DIM_OVERWORLD},
    {"desert_pyramid",Desert_Pyramid,DIM_OVERWORLD},
    {"jungle_temple",Jungle_Temple,DIM_OVERWORLD},
    {"swamp_hut",Swamp_Hut,DIM_OVERWORLD},
    {"igloo",Igloo,DIM_OVERWORLD},
    {"monument",Monument,DIM_OVERWORLD},
    {"pillager_outpost",Outpost,DIM_OVERWORLD},
    {"ruined_portal",Ruined_Portal,DIM_OVERWORLD},
    {"trial_chambers",Trial_Chambers,DIM_OVERWORLD},
    {"fortress",Fortress,DIM_NETHER},
    {"bastion_remnant",Bastion,DIM_NETHER},
    {"ruined_portal",Ruined_Portal_N,DIM_NETHER},
};
typedef struct { int index; Pos pos; int64_t distanceSquared; } ArchiveCandidate;
static int archiveCandidateOrder(const void *a,const void *b) {
    const ArchiveCandidate *x=a,*y=b;
    if(x->distanceSquared!=y->distanceSquared)return x->distanceSquared<y->distanceSquared?-1:1;
    if(x->index!=y->index)return x->index-y->index;
    if(x->pos.x!=y->pos.x)return x->pos.x<y->pos.x?-1:1;
    return (x->pos.z>y->pos.z)-(x->pos.z<y->pos.z);
}
static int queryStructures(void) {
    char profile[32],seedText[32],dimension[24],type[32],sx[24],sz[24],sr[24],sl[24],extra[2];
    if(scanf("%31s %31s %23s %31s %23s %23s %23s %23s",profile,seedText,dimension,type,sx,sz,sr,sl)!=8 || scanf("%1s",extra)==1)return 2;
    int version=!strcmp(profile,"bedrock-26.60")?MC_26_60:!strcmp(profile,"bedrock-26.50")?MC_26_50:0;
    int dim=!strcmp(dimension,"overworld")?DIM_OVERWORLD:!strcmp(dimension,"nether")?DIM_NETHER:42;
    if(!version || dim==42)return 2;
    uint64_t seed=(uint64_t)number(seedText,INT64_MIN,INT64_MAX);
    int x=(int)number(sx,-30000000,30000000),z=(int)number(sz,-30000000,30000000);
    int radius=(int)number(sr,0,4096),limit=(int)number(sl,1,32);
    if(abs(x)>30000000-radius || abs(z)>30000000-radius)return 2;
    int selected=0;
    for(unsigned i=0;i<sizeof(archiveStructures)/sizeof(*archiveStructures);i++)
        if(archiveStructures[i].dim==dim && (!strcmp(type,"all") || !strcmp(type,archiveStructures[i].name)))selected++;
    if(!selected)return 2;
    Generator g;setupGenerator(&g,version,0);applySeed(&g,dim,seed);
    ArchiveCandidate nearest[33];int count=0,total=0,checked=0;
    for(unsigned i=0;i<sizeof(archiveStructures)/sizeof(*archiveStructures);i++) {
        const ArchiveStructure *s=&archiveStructures[i];
        if(s->dim!=dim || (strcmp(type,"all") && strcmp(type,s->name)))continue;
        StructureConfig config;if(!getStructureConfig(s->type,version,&config))return 3;
        int regionSize=config.regionSize*16;
        for(int rz=floordiv(z-radius,regionSize);rz<=floordiv(z+radius,regionSize);rz++)
        for(int rx=floordiv(x-radius,regionSize);rx<=floordiv(x+radius,regionSize);rx++) {
            Pos p;checked++;
            if(!getStructurePos(s->type,version,seed,rx,rz,&p))continue;
            int64_t dx=(int64_t)p.x-x,dz=(int64_t)p.z-z,distance=dx*dx+dz*dz;
            if(distance>(int64_t)radius*radius || !isViableStructurePos(s->type,&g,p.x,p.z,0)
                || !isViableStructureTerrain(s->type,&g,p.x,p.z))continue;
            total++;nearest[count++]=(ArchiveCandidate){(int)i,p,distance};
            qsort(nearest,count,sizeof(*nearest),archiveCandidateOrder);if(count>limit)count=limit;
        }
    }
    printf("{\"engine\":\"cubiomes-bedrock-294c72ab-mcarchive1\",\"mode\":\"structures-v1\",\"profile\":\"%s\",\"totalCandidates\":%d,\"regionsChecked\":%d,\"truncated\":%s,\"candidates\":[",profile,total,checked,total>count?"true":"false");
    for(int i=0;i<count;i++) {
        ArchiveCandidate *c=&nearest[i];if(i)putchar(',');
        printf("{\"structure\":\"%s\",\"x\":%d,\"z\":%d,\"distanceSquared\":%" PRId64 "}",archiveStructures[c->index].name,c->pos.x,c->pos.z,c->distanceSquared);
    }
    puts("]}");return 0;
}

static int queryChunks(void) {
    char profile[32],dimension[24],sx[24],sz[24],sr[24],extra[2];
    if(scanf("%31s %23s %23s %23s %23s",profile,dimension,sx,sz,sr)!=5 || scanf("%1s",extra)==1)return 2;
    if(strcmp(profile,"bedrock-26.60") && strcmp(profile,"bedrock-26.50"))return 2;
    int overworld=!strcmp(dimension,"overworld");if(!overworld && strcmp(dimension,"nether"))return 2;
    int x=(int)number(sx,-30000000,29999999),z=(int)number(sz,-30000000,29999999),radius=(int)number(sr,0,8);
    int cx=floordiv(x,16),cz=floordiv(z,16);
    if(cx-radius < -1875000 || cz-radius < -1875000 || cx+radius>=1875000 || cz+radius>=1875000)return 2;
    printf("{\"engine\":\"cubiomes-bedrock-294c72ab-mcarchive1\",\"mode\":\"chunks-v1\",\"profile\":\"%s\",\"seedIndependent\":true,\"slimeApplicable\":%s,\"centerChunk\":{\"x\":%d,\"z\":%d},\"chunks\":[",profile,overworld?"true":"false",cx,cz);
    int first=1;
    for(int dz=-radius;dz<=radius;dz++)for(int dx=-radius;dx<=radius;dx++) {
        int px=cx+dx,pz=cz+dz;if(!first)putchar(',');first=0;
        printf("{\"chunkX\":%d,\"chunkZ\":%d,\"minX\":%d,\"minZ\":%d,\"maxX\":%d,\"maxZ\":%d,\"slimeChunk\":%s}",px,pz,px*16,pz*16,px*16+15,pz*16+15,overworld?(isSlimeChunk(px,pz)?"true":"false"):"null");
    }
    puts("]}");return 0;
}
