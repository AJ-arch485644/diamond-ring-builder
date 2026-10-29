'use strict';
// Shared, deterministic public-facts renderer. No commerce, delivery or private data.
const crypto = require('node:crypto');
const RENDERER_VERSION = 'diyona-select-metadata-v1';
const CATEGORY_ID = 'gid://shopify/TaxonomyCategory/ae-2-2-6-2';
const SHAPES = new Set(['Round','Oval','Radiant','Cushion','Emerald','Pear','Marquise','Asscher','Princess','Heart']);
const GRADES = {EX:'Excellent',VG:'Very Good',G:'Good',F:'Fair',P:'Poor',ID:'Ideal'};
const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']' : value && typeof value === 'object' ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}' : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function invalid(code='SELECT_METADATA_INVALID_FACTS') { const e=new Error(code);e.code=code;e.terminal=true;return e; }
function text(value,max=150) { return typeof value==='string' && value.trim() && value===value.trim() && value.length<=max && !/[\x00-\x1f\x7f<>]/.test(value) ? value : null; }
function number(value,max=1000) { return typeof value==='number' && Number.isFinite(value) && value>0 && value<=max ? value : null; }
function shown(value,places=2) { return Number(value.toFixed(places)).toString(); }
function grade(value,cut=false) {
  if(typeof value!=='string')return null;
  const key=value.trim().toUpperCase().replace(/[ _-]/g,'');
  const aliases={EXCELLENT:'EX',VERYGOOD:'VG',GOOD:'G',FAIR:'F',POOR:'P',IDEAL:'ID'};
  const code=aliases[key]||key;
  return (cut||code!=='ID') ? GRADES[code]||null : null;
}
function renderSelectMetadata({identity,attributes}={}) {
  if(!identity || !text(identity.sku) || !attributes || typeof attributes!=='object' || Array.isArray(attributes))throw invalid();
  const ident={sku:identity.sku};
  for(const [key,kind] of [['productId','Product'],['variantId','ProductVariant']])if(identity[key]!=null){
    const id=String(identity[key]);if(!new RegExp('^gid://shopify/'+kind+'/[1-9][0-9]*$').test(id))throw invalid('SELECT_METADATA_IDENTITY_MISMATCH');ident[key]=id;
  }
  if(identity.stoneId!=null){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.stoneId))throw invalid('SELECT_METADATA_IDENTITY_MISMATCH');ident.stoneId=identity.stoneId;}
  const a=attributes,carat=number(a.carat,100),shape=SHAPES.has(a.shape)?a.shape:null;
  if(!carat||!shape||!/^([D-Z])$/.test(a.color)||! /^(FL|IF|VVS1|VVS2|VS1|VS2|SI1|SI2|I1|I2|I3)$/.test(a.clarity)||a.origin!=='Lab grown'||!text(a.lab,40)||!text(a.certificate_number,100))throw invalid();
  const facts={carat,shape,color:a.color,clarity:a.clarity,origin:a.origin,lab:a.lab,certificate_number:a.certificate_number};
  for(const key of ['length','width','depth_mm','ratio','table_percent','depth_percent'])if(a[key]!=null&&a[key]!==''){
    const n=number(a[key],key.includes('percent')?100:1000);if(!n)throw invalid();facts[key]=n;
  }
  for(const key of ['cut','polish','symmetry']){const g=grade(a[key],key==='cut');if(g)facts[key]=g;}
  const fluorescence={NON:'None',NONE:'None',FAINT:'Faint',FNT:'Faint',MED:'Medium',MEDIUM:'Medium',STG:'Strong',STRONG:'Strong',VST:'Very Strong',VERYSTRONG:'Very Strong'};
  if(typeof a.fluorescence==='string'){const f=fluorescence[a.fluorescence.toUpperCase().replace(/[ _-]/g,'')];if(f)facts.fluorescence=f;}
  if(['CVD','HPHT'].includes(a.growth_method))facts.growth_method=a.growth_method;
  if(a.certificate_url!=null&&a.certificate_url!==''){
    let u;try{u=new URL(a.certificate_url);}catch{throw invalid();}if(u.protocol!=='https:'||u.username||u.password)throw invalid();facts.certificate_url=u.href;
  }
  const lead=`Diyona Select ${shown(carat)}-carat ${shape.toLowerCase()} lab-grown loose diamond with ${a.color} color and ${a.clarity} clarity.`;
  const sentences=[lead,`${a.lab} report ${a.certificate_number}.`];
  const props=[{name:'Diamond origin',value:'Lab grown'},{name:'Shape',value:shape},{name:'Carat weight',value:shown(carat)},{name:'Color',value:a.color},{name:'Clarity',value:a.clarity},{name:'Grading laboratory',value:a.lab},{name:'Grading report number',value:a.certificate_number}];
  if(facts.length&&facts.width&&facts.depth_mm){const value=`${shown(facts.length)} × ${shown(facts.width)} × ${shown(facts.depth_mm)} mm`;sentences.push(`Measures ${value}.`);props.push({name:'Measurements',value});}
  for(const [key,label,suffix] of [['ratio','Length-to-width ratio',''],['table_percent','Table','%'],['depth_percent','Depth','%']])if(facts[key]){const value=shown(facts[key])+suffix;sentences.push(`${label}: ${value}.`);props.push({name:label,value});}
  if(facts.polish&&facts.polish===facts.symmetry)sentences.push(`${facts.polish} polish and symmetry.`);
  else {if(facts.polish)sentences.push(`${facts.polish} polish.`);if(facts.symmetry)sentences.push(`${facts.symmetry} symmetry.`);}
  for(const [key,label] of [['cut','Cut grade'],['polish','Polish'],['symmetry','Symmetry'],['fluorescence','Fluorescence'],['growth_method','Growth method']])if(facts[key]){
    props.push({name:label,value:facts[key]});if(!['polish','symmetry'].includes(key))sentences.push(`${label}: ${facts[key]}.`);
  }
  const plainText=sentences.join(' ');
  const descriptionHtml='<p>'+escapeHtml(plainText)+'</p>'+(facts.certificate_url?'<p><a href="'+escapeHtml(facts.certificate_url)+'">View '+escapeHtml(a.lab)+' grading report '+escapeHtml(a.certificate_number)+'</a></p>':'');
  const title=`${shown(carat)}ct ${shape} ${a.color} ${a.clarity} Lab-Grown Diamond | Diyona Select`;
  let description=`Explore this ${shown(carat)}ct ${shape.toLowerCase()} lab-grown diamond with ${a.color} color, ${a.clarity} clarity and ${a.lab} report ${a.certificate_number}. View its images and specifications.`;
  if(description.length>160)description=`Explore this ${shown(carat)}ct ${shape.toLowerCase()} lab-grown diamond with ${a.color} color and ${a.clarity} clarity. View its grading report, images and specifications.`;
  return {version:RENDERER_VERSION,sourceHash:hash({version:RENDERER_VERSION,categoryId:CATEGORY_ID,identity:ident,facts}),descriptionHtml,plainText,seo:{title,description},categoryId:CATEGORY_ID,additionalProperties:props};
}
module.exports={RENDERER_VERSION,CATEGORY_ID,renderSelectMetadata,stable,hash,escapeHtml};
