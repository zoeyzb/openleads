function digits(value=""){return String(value||"").replace(/\D+/g,"");}

function normalizeText(value=""){
  return String(value||"")
    .toLowerCase()
    .replace(/&/g," and ")
    .replace(/\bstreet\b/g," st ")
    .replace(/\bavenue\b/g," ave ")
    .replace(/\broad\b/g," rd ")
    .replace(/\bboulevard\b/g," blvd ")
    .replace(/\bdrive\b/g," dr ")
    .replace(/\bsuite\b/g," ste ")
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\s+/g," ");
}

export function canonicalLawFirmKey(lead={}){
  const rawPhone=digits(lead.phone||lead.telephone||"");
  const phone=rawPhone.length>=10?rawPhone.slice(-10):"";
  if(phone)return "phone:"+phone;
  const name=normalizeText(lead.name||lead.title||lead.firm_name||"");
  const address=normalizeText(lead.address||lead.formatted_address||"");
  if(name||address)return "firm:"+name+"|"+address;
  return "";
}
