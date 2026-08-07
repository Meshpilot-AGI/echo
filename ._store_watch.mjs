import pkg from '@prisma/client'; const { PrismaClient } = pkg;
const prisma = new PrismaClient();
const STORES=[['urban','f51039.myshopify.com'],['storico','ys4n0u-ys.myshopify.com'],['classicoo','52j1ga-hz.myshopify.com'],['ayurpet-ind','1ygbmd-pr.myshopify.com'],['trendsetters','acmsuy-g0.myshopify.com'],['ayurpet','2684sq-mt.myshopify.com'],['mokshya','5u7mdi-ap.myshopify.com']];
async function check(){let ok=[],bad=[];for(const [slug,shop] of STORES){const s=await prisma.session.findFirst({where:{shop,isOnline:false,accessToken:{startsWith:'shpca_'}},orderBy:{id:'desc'}});let good=false;if(s){try{const r=await fetch(`https://${shop}/admin/api/2025-01/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':s.accessToken},body:'{"query":"{shop{name}}"}'});good=r.ok&&(await r.json())?.data?.shop;}catch{}}good?ok.push(slug):bad.push(slug);}return{ok,bad};}
const start=Date.now(); let prev='';
while(Date.now()-start<1500000){const {ok,bad}=await check();const line=`${ok.length}/7 green`;if(line!==prev){console.log(`[${new Date().toISOString().slice(11,19)}] ${line}${bad.length?'  pending: '+bad.join(', '):'  🎉 ALL 7 GREEN'}`);prev=line;}if(ok.length===7)break;await new Promise(r=>setTimeout(r,20000));}
await prisma.$disconnect();
