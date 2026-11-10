import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(new URL('../collector/qa/package.json',import.meta.url));
const minecraftData=require('minecraft-data');
const zh=JSON.parse(readFileSync(new URL('../frontend/src/bedrock-names.zh-CN.json',import.meta.url),'utf8'));
const data=minecraftData('bedrock_'+zh.version);
if(!data)throw new Error('Install the matching minecraft-data Bedrock registry before generating names');
const title=name=>name.replace(/^item\./,'').split('_').map(s=>s ? s[0].toUpperCase()+s.slice(1):s).join(' ');
const output={version:zh.version};
for(const [kind,rows] of [['blocks',data.blocksArray],['items',data.itemsArray],['entities',data.entitiesArray]]){
 const known=new Map(rows.map(row=>[row.name,row.displayName]));
 output[kind]=Object.fromEntries(Object.keys(zh[kind]).map(id=>[id,known.get(id)||title(id)]));
}
writeFileSync(new URL('../frontend/src/bedrock-names.en.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(Object.fromEntries(['blocks','items','entities'].map(k=>[k,Object.keys(output[k]).length])));
