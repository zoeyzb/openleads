const ROT13_DECODED_PUBLIC_TLDS=new Set([
  "com","net","org","edu","gov","us","io","co","law","biz","info"
]);

function rot13(value=""){
  return String(value).replace(/[A-Za-z]/g,ch=>{
    const code=ch.charCodeAt(0);
    const base=code>=97?97:65;
    return String.fromCharCode(base+((code-base+13)%26));
  });
}

export function decodePublishedRot13Emails(value=""){
  const text=String(value||"");
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/ig,raw=>{
    const decoded=rot13(raw);
    const domain=decoded.split("@")[1]?.toLowerCase()||"";
    const tld=domain.split(".").pop()||"";
    if(!domain.includes(".")||!ROT13_DECODED_PUBLIC_TLDS.has(tld))return raw;
    return decoded;
  });
}
