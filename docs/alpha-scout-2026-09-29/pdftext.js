const fs=require("fs"); const path=require("path");
async function main(){
  const pdfjs=await import("file:///C:/Users/joshc/Downloads/traids%20(2)/traids-bundle/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  for(const [inp,out] of [[process.argv[2],process.argv[3]]]){
    const data=new Uint8Array(fs.readFileSync(inp));
    const doc=await pdfjs.getDocument({data,disableWorker:true}).promise;
    let txt="";
    for(let p=1;p<=doc.numPages;p++){ const page=await doc.getPage(p); const c=await page.getTextContent(); txt+=`\n\n=== PAGE ${p} ===\n`+c.items.map(i=>i.str).join(" "); }
    fs.writeFileSync(out,txt); console.log(inp,"pages",doc.numPages,"chars",txt.length);
  }
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
