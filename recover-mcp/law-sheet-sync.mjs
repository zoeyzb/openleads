import { createSign } from "node:crypto";
import { lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES, qualifiesNoWebsiteLawLead, isUsableLawEmail } from "./law-firm-targeting.mjs";

const TOKEN_URL="https://oauth2.googleapis.com/token";
const SHEETS_API="https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE="https://www.googleapis.com/auth/spreadsheets";
const clean=v=>String(v??"").trim();
const b64url=v=>Buffer.from(v).toString("base64url");

function serviceAccount(raw=""){
  try{
    const x=JSON.parse(raw);
    return x?.client_email&&x?.private_key?x:null;
  }catch{return null;}
}
function normalizePrivateKey(value){return String(value||"").replace(/\\n/g,"\n");}
async function tokenFor(sa){
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const payload=b64url(JSON.stringify({iss:sa.client_email,scope:SCOPE,aud:TOKEN_URL,iat:now,exp:now+3600}));
  const unsigned=`${header}.${payload}`;
  const signer=createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  const assertion=`${unsigned}.${signer.sign(normalizePrivateKey(sa.private_key)).toString("base64url")}`;
  const response=await fetch(TOKEN_URL,{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion}),
    signal:AbortSignal.timeout(30000)
  });
  if(!response.ok)throw new Error(`law_sheet_oauth_${response.status}`);
  const json=await response.json();
  if(!json?.access_token)throw new Error("law_sheet_oauth_missing_token");
  return String(json.access_token);
}
function parseLocation(lead={}){
  let city=clean(lead.city), state=clean(lead.region||lead.state).toUpperCase();
  const raw=clean(lead.address||lead.acquisition_location||lead.target_area);
  const m=raw.match(/(?:^|,\s*)([^,]+),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i);
  if(m){ if(!city)city=clean(m[1]); if(!state)state=clean(m[2]).toUpperCase(); }
  return {city,state};
}
function typeLabel(keys=[],evidence=""){
  const labels=keys.map(k=>TARGET_LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean);
  return (labels.length?labels:lawFirmPracticeAreas(evidence))
    .map(x=>x.replace("personal injury","Personal Injury").replace("family/divorce","Family/Divorce").replace("criminal defense","Criminal Defense"))
    .join(" + ") || "Needs Classification";
}
async function collectRows(redis){
  const out=[];
  for await(const page of redis.hScanIterator("recover:leadstore:qualified",{COUNT:500})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.value)continue;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      const isLaw=clean(lead.search_profile)==="law-firm"||clean(lead.industry).toUpperCase()==="LAW_FIRM";
      if(!isLaw)continue;
      const website=clean(lead.website);
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email].map(x=>clean(x).toLowerCase()).filter(isUsableLawEmail);
      const evidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const practiceKeys=[...new Set([
        ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
        ...lawFirmPracticeKeys(evidence),
        ...(clean(lead.practice_focus)?[clean(lead.practice_focus)]:[])
      ])].filter(k=>["personal_injury","family_divorce","criminal_defense"].includes(k));
      if(!qualifiesNoWebsiteLawLead({website,emails,practice_keys:practiceKeys}))continue;

      const type=typeLabel(practiceKeys,evidence);
      const name=clean(lead.name||lead.title);
      const {city,state}=parseLocation(lead);
      const rating=Number(lead.review_rating||lead.rating||0);
      const reviews=Number(lead.review_count||lead.reviews||0);
      const quality=clean(lead.personalization_quality).toLowerCase();
      let personal="",source="";
      if(clean(lead.personalization_fact)&&quality==="specific"){
        personal=clean(lead.personalization_fact); source=clean(lead.personalization_source);
      }else if(reviews>=5&&rating>0){
        personal=`${name} has ${reviews} Google reviews at about ${rating.toFixed(1)} stars${city?` in ${city}`:""}`;
        source=clean(lead.google_maps_url||lead.maps_url);
      }
      const contextType=type==="Needs Classification"?"law":(type||"law");
      const context=city?`${contextType} firms in ${city}`:`${contextType} firms`;
      const opener=personal
        ? `I found ${name} while looking at ${context}. ${personal.replace(/^I noticed\s+/i,"")}. I couldn't find a firm website, so I wanted to reach out.`
        : `I found ${name} while looking at ${context}, but I couldn't find a firm website, so I wanted to reach out.`;
      out.push({
        priority:Number(lead.lead_priority_score||0)||0,
        email:emails[0]||"",
        row:[type,name,emails[0]||"",clean(lead.phone),city,state,personal,source,opener,
          clean(lead.attorney_count_estimate),clean(lead.firm_size_tier),rating||"",reviews||"",clean(lead.google_maps_url||lead.maps_url),
          Number(lead.lead_priority_score||0)||"","New"]
      });
    }
  }
  out.sort((a,b)=>b.priority-a.priority||String(a.row[0]).localeCompare(String(b.row[0]))||String(a.row[1]).localeCompare(String(b.row[1])));
  return out;
}

export function startLawLeadSheetSync({getRedis,serviceAccountJson="",spreadsheetId="",enabled=false,intervalMs=120000}={}){
  if(!enabled||!spreadsheetId)return;
  const sa=serviceAccount(serviceAccountJson);
  if(!sa){console.error("law_sheet_sync_not_configured");return;}
  let token="",tokenAt=0,running=false,sheetId=null,tabName="Qualified Leads";

  async function auth(){
    if(token&&Date.now()-tokenAt<50*60*1000)return token;
    token=await tokenFor(sa);tokenAt=Date.now();return token;
  }
  async function request(path,{method="GET",body}={}){
    const response=await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}${path}`,{
      method,headers:{authorization:`Bearer ${await auth()}`,...(body?{"content-type":"application/json"}:{})},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)
    });
    const text=await response.text();let json={};try{json=text?JSON.parse(text):{};}catch{json={raw:text};}
    if(!response.ok)throw new Error(`law_sheet_${response.status}_${JSON.stringify(json).slice(0,300)}`);
    return json;
  }
  async function ensureSheet(){
    const meta=await request("?fields=sheets.properties");
    const sheets=meta.sheets||[];
    let target=sheets.find(s=>s?.properties?.title===tabName);
    if(!target&&sheets[0]){
      sheetId=sheets[0].properties.sheetId;
      await request(":batchUpdate",{method:"POST",body:{requests:[{updateSheetProperties:{properties:{sheetId,title:tabName},fields:"title"}}]}});
      return;
    }
    if(!target){
      const made=await request(":batchUpdate",{method:"POST",body:{requests:[{addSheet:{properties:{title:tabName,rowCount:100,columnCount:16}}}]}});
      sheetId=made.replies?.[0]?.addSheet?.properties?.sheetId;
      return;
    }
    sheetId=target.properties.sheetId;
  }
  async function previousStatuses(){
    try{
      const range=encodeURIComponent(`'${tabName}'!A1:R5000`);
      const json=await request(`/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
      const rows=json.values||[];
      const headers=(rows[0]||[]).map(clean);
      const emailIndex=headers.indexOf("Email");
      const statusIndex=headers.indexOf("Status");
      const map=new Map();
      if(emailIndex<0||statusIndex<0)return map;
      for(const row of rows.slice(1)){
        const email=clean(row[emailIndex]).toLowerCase();
        const status=clean(row[statusIndex]);
        if(email&&status)map.set(email,status);
      }
      return map;
    }catch{return new Map();}
  }
  async function sync(){
    if(running)return;running=true;
    try{
      if(sheetId===null)await ensureSheet();
      const statuses=await previousStatuses();
      const redis=await getRedis();
      const leads=await collectRows(redis);
      for(const item of leads){if(statuses.has(item.email))item.row[15]=statuses.get(item.email);}
      const headers=["Type","Firm Name","Email","Phone","City","State","Personalization","Research Source","Suggested Opener","Attorney Count","Firm Size","Rating","Reviews","Google Maps","Priority","Status"];
      const values=[headers,...leads.map(x=>x.row)];
      const endRow=Math.max(2,values.length),rowCount=Math.max(10,endRow+1);
      await request(`/values/${encodeURIComponent(`'${tabName}'!A1:R${Math.max(5000,endRow)}`)}:clear`,{method:"POST",body:{}});
      await request(`/values/${encodeURIComponent(`'${tabName}'!A1:P${endRow}`)}?valueInputOption=RAW`,{method:"PUT",body:{range:`'${tabName}'!A1:P${endRow}`,majorDimension:"ROWS",values}});
      const widths=[155,210,220,130,120,70,320,260,360,95,115,75,75,220,75,100];
      const requests=[
        {updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount,columnCount:16,frozenRowCount:1}},fields:"gridProperties(rowCount,columnCount,frozenRowCount)"}},
        {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:16},rows:[{values:Array.from({length:16},()=>({userEnteredFormat:{backgroundColor:{red:0.10,green:0.13,blue:0.18},textFormat:{foregroundColor:{red:1,green:1,blue:1},bold:true,fontSize:10},verticalAlignment:"MIDDLE",wrapStrategy:"WRAP"}}))}],fields:"userEnteredFormat"}},
        {updateDimensionProperties:{range:{sheetId,dimension:"ROWS",startIndex:0,endIndex:1},properties:{pixelSize:34},fields:"pixelSize"}},
        {setDataValidation:{range:{sheetId,startRowIndex:1,endRowIndex:rowCount,startColumnIndex:15,endColumnIndex:16},rule:{condition:{type:"ONE_OF_LIST",values:["New","Review","Ready","Contacted","Skip"].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}},
        {setBasicFilter:{filter:{range:{sheetId,startRowIndex:0,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16}}}}
      ];
      widths.forEach((pixelSize,i)=>requests.push({updateDimensionProperties:{range:{sheetId,dimension:"COLUMNS",startIndex:i,endIndex:i+1},properties:{pixelSize},fields:"pixelSize"}}));
      requests.push({repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16},cell:{userEnteredFormat:{verticalAlignment:"TOP",wrapStrategy:"WRAP"}},fields:"userEnteredFormat(verticalAlignment,wrapStrategy)"}});
      await request(":batchUpdate",{method:"POST",body:{requests}});
      console.log(JSON.stringify({event:"law_sheet_sync",rows:leads.length,spreadsheetId,tabName}));
    }catch(error){console.error("law_sheet_sync_error",error?.message||error);}
    finally{running=false;}
  }
  void sync();
  setInterval(()=>void sync(),Math.max(60000,Number(intervalMs)||120000)).unref?.();
}
