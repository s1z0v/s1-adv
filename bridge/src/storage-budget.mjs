import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

// Admission budget, not a filesystem quota or an automatic archive deleter.
export class PrivateStorageBudget {
  constructor(config) {
    const settings=config.storage || {};
    this.maxBytes=positive(settings.maxBytes,256*1024*1024);
    this.reserveBytes=positive(settings.reservePerRequestBytes,32*1024*1024);
    this.minFreeBytes=Number.isSafeInteger(settings.minFreeBytes)&&settings.minFreeBytes>=0 ? settings.minFreeBytes :128*1024*1024;
    this.maxEntries=positive(settings.maxEntries,10000);
    const candidates=[config.stateDir,...Object.values(config.media||{}),config.assets?.rootDir,config.assets?.logsDir,config.firmware?.rootDir]
      .filter(value=>typeof value==="string").map(value=>path.resolve(value)).sort((a,b)=>a.length-b.length);
    this.roots=[];
    for(const root of candidates)if(!this.roots.some(parent=>root===parent||root.startsWith(parent+path.sep)))this.roots.push(root);
    this.reserved=0;this.queue=Promise.resolve();
  }
  async usage() {
    let bytes=0,entries=0;const pending=[...this.roots];
    while(pending.length){
      const directory=pending.pop();let children;
      try{children=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==="ENOENT")continue;throw error;}
      for(const child of children){
        if(++entries>this.maxEntries)throw new Error("storage_entry_limit");
        const file=path.join(directory,child.name);
        if(child.isDirectory())pending.push(file);
        else if(child.isFile()){
          try{bytes+=(await stat(file)).size;}catch(error){if(error.code!=="ENOENT")throw error;}
        }
        if(bytes>this.maxBytes)throw new Error("storage_byte_limit");
      }
    }
    return bytes;
  }
  acquire() {
    const result=this.queue.then(async()=>{
      try {
        const bytes=await this.usage();
        if(bytes+this.reserved+this.reserveBytes>this.maxBytes)return {ok:false};
        // Check every configured storage filesystem, not just the first root.
        for(const root of this.roots){
          const fs=await statfs(root);
          if(fs.bavail*fs.bsize<this.minFreeBytes+this.reserved+this.reserveBytes)return {ok:false};
        }
        this.reserved+=this.reserveBytes;let released=false;
        return {ok:true,release:()=>{if(released)return;released=true;this.reserved-=this.reserveBytes;}};
      }catch{return {ok:false};}
    });
    this.queue=result.then(()=>{},()=>{});return result;
  }
}
