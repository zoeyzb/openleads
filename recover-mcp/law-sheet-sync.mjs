import { createSign } from "node:crypto";
import { LAW_PRACTICES, lawFirmPracticeAreas, lawFirmPracticeKeys, qualifiesNoWebsiteLawLead, isUsableLawEmail } from "./law-firm-targeting.mjs";

const TOKEN_URL="https://oauth2.googleapis.com/token";
const SHEETS_API="https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE="https://www.googleapis.com/auth/spreadsheets";
const clean=v=>String(v??"").trim();

const GENERIC_CONTACT_LOCAL=new Set(["info","contact","office","admin","hello","support","mail","reception","receptionist","intake","legal","law","team","general","marketing"]);
function contactEmailRank(email=""){
  const local=clean(email).toLowerCase().split("@")[0]||"";
  if(GENERIC_CONTACT_LOCAL.has(local))return 5;
  if(/^(info|contact|office|admin|hello|support|mail|reception|intake|legal|law|team|general|marketing)[._+-]/.test(local))return 4;
  if(/^[a-z][a-z0-9.'_-]{2,}$/.test(local))return 1;
  return 3;
}
const BLOCKED_CONTACT_DOMAINS=["reachattorneys.com","birdeye.com","avvo.com","findlaw.com","lawyers.com","justia.com","martindale.com","superlawyers.com","yellowpages.com","yelp.com"];
function exportableLawEmail(value=""){
  const email=clean(value).toLowerCase();
  if(!isUsableLawEmail(email))return false;
  const domain=email.split("@")[1]||"";
  return !BLOCKED_CONTACT_DOMAINS.some(d=>domain===d||domain.endsWith("."+d));
}
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
  const labels=keys.map(k=>LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean);
  return (labels.length?labels:lawFirmPracticeAreas(evidence))
    .map(x=>x.replace("personal injury","Personal Injury").replace("family/divorce","Family/Divorce").replace("criminal defense","Criminal Defense"))
    .join(" + ") || "Needs Classification";
}
async function collectRows(redis){
  const out=[];
  const readyKeys=await redis.sMembers("recover:law-firm:qualified:v3");
  for(let offset=0;offset<readyKeys.length;offset+=250){
    const keys=readyKeys.slice(offset,offset+250);
    const values=await redis.hmGet("recover:leadstore:qualified",keys);
    for(let i=0;i<keys.length;i++){
      if(!values[i])continue;
      let lead;try{lead=JSON.parse(values[i])||{};}catch{continue;}
      const isLaw=clean(lead.search_profile)==="law-firm"||clean(lead.industry).toUpperCase()==="LAW_FIRM";
      if(!isLaw)continue;
      const website=clean(lead.website||lead.website_url);
      if(/^https?:\/\//i.test(website))continue;
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>clean(x).toLowerCase()).filter(exportableLawEmail)
        .sort((a,b)=>contactEmailRank(a)-contactEmailRank(b)||a.localeCompare(b));
      const sourceVerified=lead.law_email_source_verified===true||lead.email_source_verified===true;
      const attorneyCount=Number(lead.attorney_count_estimate||lead.attorney_count||0);
      const sizeEvidenceVerified=lead.attorney_count_evidence_verified===true;
      if(!emails.length||!sourceVerified||!sizeEvidenceVerified||attorneyCount<2||attorneyCount>10)continue;

      const evidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const practiceKeys=[...new Set([
        ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
        ...lawFirmPracticeKeys(evidence),
        ...(clean(lead.practice_focus)?[clean(lead.practice_focus)]:[])
      ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k));
      const type=typeLabel(practiceKeys,evidence);
      const name=clean(lead.name||lead.title);
      const {city,state}=parseLocation(lead);
      const rating=Number(lead.review_rating||lead.rating||0);
      const reviews=Number(lead.review_count||lead.reviews||0);
      const quality=clean(lead.personalization_quality).toLowerCase();
      let personal="",source=clean(lead.law_email_source);
      if(clean(lead.personalization_fact)&&quality==="specific"){
        personal=clean(lead.personalization_fact);
        if(!source)source=clean(lead.personalization_source);
      }else if(reviews>=5&&rating>0){
        personal=`${name} has ${reviews} Google reviews at about ${rating.toFixed(1)} stars${city?` in ${city}`:""}`;
        if(!source)source=clean(lead.google_maps_url||lead.maps_url);
      }
      if(!source)source=clean(lead.personalization_source||lead.google_maps_url||lead.maps_url);
      const contextType=type==="Needs Classification"?"law":(type||"law");
      const context=city?`${contextType} firms in ${city}`:`${contextType} firms`;
      const opener=personal
        ? `I found ${name} while looking at ${context}. ${personal.replace(/^I noticed\s+/i,"")}. I couldn't find a firm website, so I wanted to reach out.`
        : `I found ${name} while looking at ${context}, but I couldn't find a firm website, so I wanted to reach out.`;
      out.push({
        priority:Number(lead.lead_priority_score||0)||0,
        email:emails[0]||"",
        row:[type,name,emails[0]||"",clean(lead.phone),city,state,personal,source,opener,
          attorneyCount,clean(lead.firm_size_tier)||String(attorneyCount),
          rating||"",reviews||"",clean(lead.google_maps_url||lead.maps_url),
          Number(lead.lead_priority_score||0)||"","Ready"]
      });
    }
  }
  out.sort((a,b)=>b.priority-a.priority||String(a.row[1]).localeCompare(String(b.row[1])));
  return out;
}

async function collectVerifiedEmailCandidateRows(redis){
  const out=[];
  const candidateKeys=await redis.sMembers("recover:law-firm:email-candidates:v1");
  for(let offset=0;offset<candidateKeys.length;offset+=250){
    const keys=candidateKeys.slice(offset,offset+250);
    const values=await redis.hmGet("recover:leadstore:qualified",keys);
    for(let i=0;i<keys.length;i++){
      if(!values[i])continue;
      let lead;try{lead=JSON.parse(values[i])||{};}catch{continue;}
      const isLaw=clean(lead.search_profile)==="law-firm"||clean(lead.industry).toUpperCase()==="LAW_FIRM";
      if(!isLaw)continue;
      const website=clean(lead.website||lead.website_url);
      if(/^https?:\/\//i.test(website))continue;
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>clean(x).toLowerCase()).filter(exportableLawEmail)
        .sort((a,b)=>contactEmailRank(a)-contactEmailRank(b)||a.localeCompare(b));
      const sourceVerified=lead.law_email_source_verified===true||lead.email_source_verified===true;
      if(!emails.length||!sourceVerified)continue;

      const attorneyCount=Number(lead.attorney_count_estimate||lead.attorney_count||0);
      const sizeEvidenceVerified=lead.attorney_count_evidence_verified===true;
      const sizeReady=sizeEvidenceVerified&&attorneyCount>=2&&attorneyCount<=10;
      const evidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const practiceKeys=[...new Set([
        ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
        ...lawFirmPracticeKeys(evidence),
        ...(clean(lead.practice_focus)?[clean(lead.practice_focus)]:[])
      ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k));
      const type=typeLabel(practiceKeys,evidence);
      const name=clean(lead.name||lead.title);
      const {city,state}=parseLocation(lead);
      const rating=Number(lead.review_rating||lead.rating||0);
      const reviews=Number(lead.review_count||lead.reviews||0);
      const source=clean(lead.law_email_source||lead.email_source||lead.email_evidence_url||lead.personalization_source||lead.google_maps_url||lead.maps_url);
      const personal=clean(lead.personalization_fact);
      const contextType=type==="Needs Classification"?"law":(type||"law");
      const context=city?`${contextType} firms in ${city}`:`${contextType} firms`;
      const opener=`I found ${name} while looking at ${context}, but I couldn't find a firm website, so I wanted to reach out.`;
      const status=sizeReady?"Ready":"Needs Size Proof";
      out.push({
        priority:Number(lead.lead_priority_score||0)||0,
        email:emails[0]||"",
        row:[type,name,emails[0]||"",clean(lead.phone),city,state,personal,source,opener,
          sizeEvidenceVerified?attorneyCount:"",
          clean(lead.firm_size_tier)||(sizeEvidenceVerified?String(attorneyCount):"Unknown"),
          rating||"",reviews||"",clean(lead.google_maps_url||lead.maps_url),
          Number(lead.lead_priority_score||0)||"",status]
      });
    }
  }
  out.sort((a,b)=>{
    const ar=a.row[15]==="Ready"?0:1, br=b.row[15]==="Ready"?0:1;
    return ar-br||b.priority-a.priority||String(a.row[1]).localeCompare(String(b.row[1]));
  });
  return out;
}

async function collectWebsiteRefreshRows(redis){
  const out=[];
  const readyKeys=await redis.sMembers("recover:law-firm:website-refresh-ready:v1");
  for(let offset=0;offset<readyKeys.length;offset+=250){
    const keys=readyKeys.slice(offset,offset+250);
    const values=await redis.hmGet("recover:law-firm:website-refresh:v1",keys);
    for(let i=0;i<keys.length;i++){
      if(!values[i])continue;
      let lead;try{lead=JSON.parse(values[i])||{};}catch{continue;}
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>clean(x).toLowerCase()).filter(exportableLawEmail)
        .sort((a,b)=>contactEmailRank(a)-contactEmailRank(b)||a.localeCompare(b));
      if(!emails.length)continue;
      const audit=lead.website_audit||{};
      const pains=Array.isArray(audit.pain_points)?audit.pain_points:[];
      if(pains.length<2)continue;
      const evidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const practiceKeys=[...new Set([
        ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
        ...lawFirmPracticeKeys(evidence),
        ...(clean(lead.practice_focus)?[clean(lead.practice_focus)]:[])
      ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k));
      const baseType=typeLabel(practiceKeys,evidence);
      const type=`Website Refresh · ${baseType}`;
      const name=clean(lead.name||lead.title);
      const {city,state}=parseLocation(lead);
      const rating=Number(lead.review_rating||lead.rating||0);
      const reviews=Number(lead.review_count||lead.reviews||0);
      const personal=pains.slice(0,3).map(x=>clean(x.label)).filter(Boolean).join(" · ");
      const source=clean(lead.law_email_source||lead.website||audit.audited_url);
      const contextType=baseType==="Needs Classification"?"law":baseType;
      const context=city?`${contextType} firms in ${city}`:`${contextType} firms`;
      const primary=clean(audit.primary_pain_point||pains[0]?.label||"website conversion issue");
      const opener=`I found ${name} while looking at ${context}. I noticed ${primary.charAt(0).toLowerCase()+primary.slice(1)} on the firm's site, so I wanted to reach out.`;
      out.push({
        priority:Number(lead.lead_priority_score||0)||0,
        email:emails[0]||"",
        row:[type,name,emails[0]||"",clean(lead.phone),city,state,personal,source,opener,
          clean(lead.attorney_count_estimate),clean(lead.firm_size_tier),rating||"",reviews||"",clean(lead.google_maps_url||lead.maps_url),
          Number(lead.lead_priority_score||0)||"","New"]
      });
    }
  }
  out.sort((a,b)=>b.priority-a.priority||String(a.row[1]).localeCompare(String(b.row[1])));
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
  async function ensureAdditionalSheet(title){
    const meta=await request("?fields=sheets.properties");
    const target=(meta.sheets||[]).find(s=>s?.properties?.title===title);
    if(target)return target.properties.sheetId;
    const made=await request(":batchUpdate",{method:"POST",body:{requests:[{addSheet:{properties:{title,gridProperties:{rowCount:100,columnCount:16}}}}]}});
    return made.replies?.[0]?.addSheet?.properties?.sheetId;
  }
  async function previousStatusesFor(title){
    try{
      const range=encodeURIComponent(`'${title}'!A1:R5000`);
      const json=await request(`/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
      const rows=json.values||[];
      const headers=(rows[0]||[]).map(clean);
      const emailIndex=headers.indexOf("Email"),statusIndex=headers.indexOf("Status");
      const map=new Map();
      if(emailIndex<0||statusIndex<0)return map;
      for(const row of rows.slice(1)){
        const email=clean(row[emailIndex]).toLowerCase(),status=clean(row[statusIndex]);
        if(email&&status)map.set(email,status);
      }
      return map;
    }catch{return new Map();}
  }
  async function writeRowsToTab(title,targetSheetId,leads){
    const headers=["Type","Firm","Email","Phone","City","State","Personal Angle","Source","Opener","Attorneys","Firm Size","Rating","Reviews","Maps","Priority","Status"];
    const values=[headers,...leads.map(x=>x.row)];
    const endRow=Math.max(2,values.length),rowCount=Math.max(10,endRow+1);
    await request(`/values/${encodeURIComponent(`'${title}'!A1:R${Math.max(5000,endRow)}`)}:clear`,{method:"POST",body:{}});
    await request(`/values/${encodeURIComponent(`'${title}'!A1:P${endRow}`)}?valueInputOption=RAW`,{method:"PUT",body:{range:`'${title}'!A1:P${endRow}`,majorDimension:"ROWS",values}});
    const widths=[125,175,185,112,100,55,190,145,235,65,90,58,58,145,58,85];
    const requests=[
      {updateSheetProperties:{properties:{sheetId:targetSheetId,gridProperties:{rowCount,columnCount:16,frozenRowCount:1}},fields:"gridProperties(rowCount,columnCount,frozenRowCount)"}},
      {updateCells:{range:{sheetId:targetSheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:16},rows:[{values:Array.from({length:16},()=>({userEnteredFormat:{backgroundColor:{red:0.10,green:0.13,blue:0.18},textFormat:{foregroundColor:{red:1,green:1,blue:1},bold:true,fontSize:10},verticalAlignment:"MIDDLE",wrapStrategy:"WRAP"}}))}],fields:"userEnteredFormat"}},
      {updateDimensionProperties:{range:{sheetId:targetSheetId,dimension:"ROWS",startIndex:0,endIndex:1},properties:{pixelSize:30},fields:"pixelSize"}},
      {setDataValidation:{range:{sheetId:targetSheetId,startRowIndex:1,endRowIndex:rowCount,startColumnIndex:15,endColumnIndex:16},rule:{condition:{type:"ONE_OF_LIST",values:["New","Review","Ready","Contacted","Skip"].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}},
      {setBasicFilter:{filter:{range:{sheetId:targetSheetId,startRowIndex:0,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16}}}}
    ];
    widths.forEach((pixelSize,i)=>requests.push({updateDimensionProperties:{range:{sheetId:targetSheetId,dimension:"COLUMNS",startIndex:i,endIndex:i+1},properties:{pixelSize},fields:"pixelSize"}}));
    requests.push(
      {updateDimensionProperties:{range:{sheetId:targetSheetId,dimension:"ROWS",startIndex:1,endIndex:rowCount},properties:{pixelSize:28},fields:"pixelSize"}},
      {repeatCell:{range:{sheetId:targetSheetId,startRowIndex:1,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16},cell:{userEnteredFormat:{verticalAlignment:"MIDDLE",wrapStrategy:"CLIP",textFormat:{fontSize:9}}},fields:"userEnteredFormat(verticalAlignment,wrapStrategy,textFormat.fontSize)"}}
    );
    await request(":batchUpdate",{method:"POST",body:{requests}});
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

      // Keep source-verified no-website email inventory visible even while
      // attorney-count evidence is still pending. This tab is research inventory,
      // not the strict send-ready qualification list.
      const candidateTitle="Verified Email Candidates";
      const candidateSheetId=await ensureAdditionalSheet(candidateTitle);
      const candidateStatuses=await previousStatusesFor(candidateTitle);
      const emailCandidates=await collectVerifiedEmailCandidateRows(redis);
      for(const item of emailCandidates){
        if(candidateStatuses.has(item.email)&&item.row[15]!=="Ready")item.row[15]=candidateStatuses.get(item.email);
      }
      await writeRowsToTab(candidateTitle,candidateSheetId,emailCandidates);
      const headers=["Type","Firm","Email","Phone","City","State","Personal Angle","Source","Opener","Attorneys","Firm Size","Rating","Reviews","Maps","Priority","Status"];
      const values=[headers,...leads.map(x=>x.row)];
      const endRow=Math.max(2,values.length),rowCount=Math.max(10,endRow+1);
      await request(`/values/${encodeURIComponent(`'${tabName}'!A1:R${Math.max(5000,endRow)}`)}:clear`,{method:"POST",body:{}});
      await request(`/values/${encodeURIComponent(`'${tabName}'!A1:P${endRow}`)}?valueInputOption=RAW`,{method:"PUT",body:{range:`'${tabName}'!A1:P${endRow}`,majorDimension:"ROWS",values}});
      const widths=[125,175,185,112,100,55,190,145,235,65,90,58,58,145,58,85];
      const requests=[
        {updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount,columnCount:16,frozenRowCount:1}},fields:"gridProperties(rowCount,columnCount,frozenRowCount)"}},
        {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:16},rows:[{values:Array.from({length:16},()=>({userEnteredFormat:{backgroundColor:{red:0.10,green:0.13,blue:0.18},textFormat:{foregroundColor:{red:1,green:1,blue:1},bold:true,fontSize:10},verticalAlignment:"MIDDLE",wrapStrategy:"WRAP"}}))}],fields:"userEnteredFormat"}},
        {updateDimensionProperties:{range:{sheetId,dimension:"ROWS",startIndex:0,endIndex:1},properties:{pixelSize:30},fields:"pixelSize"}},
        {setDataValidation:{range:{sheetId,startRowIndex:1,endRowIndex:rowCount,startColumnIndex:15,endColumnIndex:16},rule:{condition:{type:"ONE_OF_LIST",values:["New","Review","Ready","Contacted","Skip"].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}},
        {setBasicFilter:{filter:{range:{sheetId,startRowIndex:0,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16}}}}
      ];
      widths.forEach((pixelSize,i)=>requests.push({updateDimensionProperties:{range:{sheetId,dimension:"COLUMNS",startIndex:i,endIndex:i+1},properties:{pixelSize},fields:"pixelSize"}}));
      requests.push(
        {updateDimensionProperties:{range:{sheetId,dimension:"ROWS",startIndex:1,endIndex:rowCount},properties:{pixelSize:28},fields:"pixelSize"}},
        {repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:endRow,startColumnIndex:0,endColumnIndex:16},cell:{userEnteredFormat:{verticalAlignment:"MIDDLE",wrapStrategy:"CLIP",textFormat:{fontSize:9}}},fields:"userEnteredFormat(verticalAlignment,wrapStrategy,textFormat.fontSize)"}}
      );
      await request(":batchUpdate",{method:"POST",body:{requests}});
      console.log(JSON.stringify({event:"law_sheet_sync",rows:leads.length,emailCandidateRows:emailCandidates.length,spreadsheetId,tabName,candidateTitle}));

      // Website-refresh inventory is intentionally excluded from this campaign.
    }catch(error){console.error("law_sheet_sync_error",error?.message||error);}
    finally{running=false;}
  }
  void sync();
  setInterval(()=>void sync(),Math.max(60000,Number(intervalMs)||120000)).unref?.();
}
