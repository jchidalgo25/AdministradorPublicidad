const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const sql     = require('mssql');

const app  = express();
const PORT = 3030;
const DATA_FILE          = path.join(__dirname, 'data.json');
const DATA_BANNER_FILE   = path.join(__dirname, 'data-banner.json');
const IMAGES_DIR         = path.join(__dirname, 'imagenes');
const BANNER_DIR         = path.join(__dirname, 'imagenes-banner');
const CAMPANA_DIR        = path.join(__dirname, 'imagenes-campana');
const CAMPANA_BANNER_DIR = path.join(__dirname, 'imagenes-campana-banner');
const SETS_DIR           = path.join(__dirname, 'imagenes-sets');
const SETS_BANNER_DIR    = path.join(__dirname, 'imagenes-sets-banner');

function safeReadJson(f,d){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){return d;}}
function safeWriteJson(f,d){try{fs.writeFileSync(f,JSON.stringify(d,null,2));return true;}catch(e){console.error('Error escribiendo '+f+':',e.message);return false;}}
function safeEnsureDir(d){try{if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});}catch(e){console.error('No se pudo crear',d,e.message);}}
function safeEnsureFile(f,d){try{if(!fs.existsSync(f))fs.writeFileSync(f,JSON.stringify(d,null,2));}catch(e){console.error('No se pudo crear',f,e.message);}}

safeEnsureDir(IMAGES_DIR); safeEnsureDir(BANNER_DIR);
safeEnsureDir(CAMPANA_DIR); safeEnsureDir(CAMPANA_BANNER_DIR);
safeEnsureDir(SETS_DIR); safeEnsureDir(SETS_BANNER_DIR);
safeEnsureFile(DATA_FILE,{sets:[],campanas:[],config:{duration:5,fit:'cover',days:[1,2,3,4,5],timeStart:'08:00',timeEnd:'21:00'}});
safeEnsureFile(DATA_BANNER_FILE,{sets:[],campanas:[],config:{duration:8,fit:'contain'}});

const sqlConfig={user:'svc_sql_pos',password:'a17472Ol0',server:'192.168.127.162',database:'POS',options:{encrypt:false,trustServerCertificate:true}};
let pool=null;
async function getPool(){if(!pool)pool=await sql.connect(sqlConfig);return pool;}

app.use(cors());
app.use(express.json());
app.use(session({
  secret: 'publicidad-pos-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// ── Rutas públicas (no requieren login) ──────────────────────────
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// ── Protección de la página de administración ────────────────────
app.get('/admin-carrusel.html', (req, res) => {
  if (req.session && req.session.usuario) {
    return res.sendFile(path.join(__dirname, 'admin-carrusel.html'));
  }
  res.redirect('/login.html');
});

app.use(express.static(__dirname));
app.use('/imagenes',express.static(IMAGES_DIR));
app.use('/imagenes-banner',express.static(BANNER_DIR));
app.use('/imagenes-campana',express.static(CAMPANA_DIR));
app.use('/imagenes-campana-banner',express.static(CAMPANA_BANNER_DIR));
app.use('/imagenes-sets',express.static(SETS_DIR));
app.use('/imagenes-sets-banner',express.static(SETS_BANNER_DIR));

function makeUpload(dir){
  return multer({storage:multer.diskStorage({
    destination:(req,file,cb)=>cb(null,dir),
    filename:(req,file,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(file.originalname))
  }),limits:{fileSize:1*1024*1024},fileFilter:(req,file,cb)=>{const ok=/jpeg|jpg|png|webp|gif/.test(path.extname(file.originalname).toLowerCase());cb(ok?null:new Error('Solo imágenes'),ok);}});
}
const upload            = makeUpload(IMAGES_DIR);
const uploadBanner      = makeUpload(BANNER_DIR);
const uploadCampana     = makeUpload(CAMPANA_DIR);
const uploadCampanaBanner = makeUpload(CAMPANA_BANNER_DIR);
const uploadSet         = makeUpload(SETS_DIR);
const uploadSetBanner   = makeUpload(SETS_BANNER_DIR);


// ── Helper: resolver imágenes según establecimiento ──────────────
function resolverImagenesSet(data, est) {
  const sets = data.sets || [];
  
  // ── Primero verificar campañas activas ──
  const ahora = new Date();
  const campanas = data.campanas || [];
  
  // Buscar campaña activa para este establecimiento específico
  for (const c of campanas) {
    if (!c.activo) continue;
    const desde = new Date(c.fecha_desde+'T'+(c.hora_desde||'00:00'));
    const hasta  = new Date(c.fecha_hasta+'T'+(c.hora_hasta||'23:59'));
    if (ahora >= desde && ahora <= hasta && c.images && c.images.length > 0) {
      const esGlobal = !c.establecimientos || c.establecimientos.length === 0;
      const esLocal  = !esGlobal && c.establecimientos.includes(est);
      if (esLocal) return { images: c.images, campaña: c.nombre };
    }
  }
  // Buscar campaña global activa
  for (const c of campanas) {
    if (!c.activo) continue;
    const desde = new Date(c.fecha_desde+'T'+(c.hora_desde||'00:00'));
    const hasta  = new Date(c.fecha_hasta+'T'+(c.hora_hasta||'23:59'));
    const esGlobal = !c.establecimientos || c.establecimientos.length === 0;
    if (ahora >= desde && ahora <= hasta && esGlobal && c.images && c.images.length > 0) {
      return { images: c.images, campaña: c.nombre };
    }
  }

  // ── Sin campaña activa — buscar sets ──
  const setsLocal = sets.filter(s => s.activo && s.establecimientos && s.establecimientos.length > 0 && s.establecimientos.includes(est));
  if (setsLocal.length > 0) return { images: setsLocal.flatMap(s => s.images||[]), campaña: null };
  const setsGlobales = sets.filter(s => s.activo && (!s.establecimientos || s.establecimientos.length === 0));
  return { images: setsGlobales.flatMap(s => s.images||[]), campaña: null };
}

// ════════════════════════════════════════════════════════════════
// CARRUSEL - CONFIG
// ════════════════════════════════════════════════════════════════
app.get('/api/data',(req,res)=>res.json(safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}})));
app.put('/api/config',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});d.config={...d.config,...req.body};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});});

// ════════════════════════════════════════════════════════════════
// CARRUSEL - SETS
// ════════════════════════════════════════════════════════════════
app.get('/api/sets',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});res.json(d.sets||[]);});

app.post('/api/sets',(req,res)=>{
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  if(!d.sets)d.sets=[];
  const nuevo={id:Date.now(),...req.body,images:[]};
  d.sets.push(nuevo);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);
  res.json({ok:true,id:nuevo.id});
});

app.put('/api/sets/:id',(req,res)=>{
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  const idx=d.sets.findIndex(s=>s.id==req.params.id);
  if(idx>=0){d.sets[idx]={...d.sets[idx],...req.body,id:d.sets[idx].id,images:d.sets[idx].images};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});}
  else res.status(404).json({error:'No encontrado'});
});

app.delete('/api/sets/:id',(req,res)=>{
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  d.sets=d.sets.filter(s=>s.id!=req.params.id);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});
});

app.post('/api/sets/:id/upload',uploadSet.array('images',50),(req,res)=>{
  console.log('[UPLOAD SETS] id:', req.params.id);
  console.log('[UPLOAD SETS] SETS_DIR:', SETS_DIR);
  console.log('[UPLOAD SETS] dir existe:', fs.existsSync(SETS_DIR));
  console.log('[UPLOAD SETS] req.files:', req.files ? req.files.map(f=>({name:f.originalname,size:f.size,dest:f.destination,filename:f.filename})) : 'NINGUNO');
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  const s=d.sets.find(s=>s.id==req.params.id);
  if(!s)return res.status(404).json({error:'No encontrado'});
  if(!s.images)s.images=[];
  req.files.forEach(f=>s.images.push({id:Date.now()+Math.random(),name:f.originalname,file:f.filename,url:'/imagenes-sets/'+f.filename}));
  d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true,count:req.files.length});
});

app.delete('/api/sets/:id/image/:file',(req,res)=>{
  try{const fp=path.join(SETS_DIR,req.params.file);if(fs.existsSync(fp))fs.unlinkSync(fp);}catch(e){}
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  const s=d.sets.find(s=>s.id==req.params.id);
  if(s&&s.images)s.images=s.images.filter(i=>i.file!==req.params.file);
  d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});
});

app.put('/api/sets/:id/order',(req,res)=>{
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  const s=d.sets.find(s=>s.id==req.params.id);
  if(s)s.images=req.body.images;
  d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});
});

// ── API para que el carrusel.html obtenga imágenes por establecimiento ──
app.get('/api/imagenes',(req,res)=>{
  const est=req.query.est||'';
  const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});
  const resultado=resolverImagenesSet(d,est);
  res.json({images:resultado.images,config:d.config,campaña:resultado.campaña});
});
// ════════════════════════════════════════════════════════════════
// CAMPAÑAS CARRUSEL
// ════════════════════════════════════════════════════════════════
app.get('/api/campanas',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});res.json(d.campanas||[]);});
app.post('/api/campanas',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});if(!d.campanas)d.campanas=[];const nueva={id:Date.now(),...req.body,images:[]};d.campanas.push(nueva);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true,id:nueva.id});});
app.put('/api/campanas/:id',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});const idx=d.campanas.findIndex(c=>c.id==req.params.id);if(idx>=0){d.campanas[idx]={...d.campanas[idx],...req.body,id:d.campanas[idx].id,images:d.campanas[idx].images};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});}else res.status(404).json({error:'No encontrado'});});
app.delete('/api/campanas/:id',(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});d.campanas=d.campanas.filter(c=>c.id!=req.params.id);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});});
app.post('/api/campanas/:id/upload',uploadCampana.array('images',20),(req,res)=>{const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});const c=d.campanas.find(c=>c.id==req.params.id);if(!c)return res.status(404).json({error:'No encontrado'});if(!c.images)c.images=[];req.files.forEach(f=>c.images.push({id:Date.now()+Math.random(),name:f.originalname,file:f.filename,url:'/imagenes-campana/'+f.filename}));d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true,count:req.files.length});});
app.delete('/api/campanas/:id/image/:file',(req,res)=>{try{const fp=path.join(CAMPANA_DIR,req.params.file);if(fs.existsSync(fp))fs.unlinkSync(fp);}catch(e){}const d=safeReadJson(DATA_FILE,{sets:[],campanas:[],config:{}});const c=d.campanas.find(c=>c.id==req.params.id);if(c&&c.images)c.images=c.images.filter(i=>i.file!==req.params.file);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_FILE,d);res.json({ok:true});});

// ════════════════════════════════════════════════════════════════
// BANNER - SETS
// ════════════════════════════════════════════════════════════════
app.get('/api/banner/data',(req,res)=>{
  const d = safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});
  // Si no tiene updatedAt, agregarlo ahora y guardarlo
  if(!d.updatedAt) {
    d.updatedAt = new Date().toISOString();
    safeWriteJson(DATA_BANNER_FILE, d);
  }
  res.json(d);
});
// Agregar después del endpoint anterior
app.get('/api/banner/status',(req,res)=>{
  const d = safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});
  res.json({ updatedAt: d.updatedAt || null });
});
app.put('/api/banner/config',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});d.config={...d.config,...req.body};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});});
app.get('/api/banner/sets',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});res.json(d.sets||[]);});
app.post('/api/banner/sets',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});if(!d.sets)d.sets=[];const nuevo={id:Date.now(),...req.body,images:[]};d.sets.push(nuevo);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true,id:nuevo.id});});
app.put('/api/banner/sets/:id',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const idx=d.sets.findIndex(s=>s.id==req.params.id);if(idx>=0){d.sets[idx]={...d.sets[idx],...req.body,id:d.sets[idx].id,images:d.sets[idx].images};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});}else res.status(404).json({error:'No encontrado'});});
app.delete('/api/banner/sets/:id',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});d.sets=d.sets.filter(s=>s.id!=req.params.id);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});});
app.post('/api/banner/sets/:id/upload',uploadSetBanner.array('images',20),(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const s=d.sets.find(s=>s.id==req.params.id);if(!s)return res.status(404).json({error:'No encontrado'});if(!s.images)s.images=[];req.files.forEach(f=>s.images.push({id:Date.now()+Math.random(),name:f.originalname,file:f.filename,url:'/imagenes-sets-banner/'+f.filename}));d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true,count:req.files.length});});
app.delete('/api/banner/sets/:id/image/:file',(req,res)=>{try{const fp=path.join(SETS_BANNER_DIR,req.params.file);if(fs.existsSync(fp))fs.unlinkSync(fp);}catch(e){}const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const s=d.sets.find(s=>s.id==req.params.id);if(s&&s.images)s.images=s.images.filter(i=>i.file!==req.params.file);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});});
app.get('/api/banner/imagenes',(req,res)=>{
  const est=req.query.est||'';
  const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});
  const resultado=resolverImagenesSet(d,est);
  res.json({images:resultado.images,config:d.config,campaña:resultado.campaña});
});
// CAMPAÑAS BANNER
app.get('/api/banner/campanas',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});res.json(d.campanas||[]);});
app.post('/api/banner/campanas',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});if(!d.campanas)d.campanas=[];const nueva={id:Date.now(),...req.body,images:[]};d.campanas.push(nueva);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true,id:nueva.id});});
app.put('/api/banner/campanas/:id',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const idx=d.campanas.findIndex(c=>c.id==req.params.id);if(idx>=0){d.campanas[idx]={...d.campanas[idx],...req.body,id:d.campanas[idx].id,images:d.campanas[idx].images};d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});}else res.status(404).json({error:'No encontrado'});});
app.delete('/api/banner/campanas/:id',(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});d.campanas=d.campanas.filter(c=>c.id!=req.params.id);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});});
app.post('/api/banner/campanas/:id/upload',uploadCampanaBanner.array('images',20),(req,res)=>{const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const c=d.campanas.find(c=>c.id==req.params.id);if(!c)return res.status(404).json({error:'No encontrado'});if(!c.images)c.images=[];req.files.forEach(f=>c.images.push({id:Date.now()+Math.random(),name:f.originalname,file:f.filename,url:'/imagenes-campana-banner/'+f.filename}));d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true,count:req.files.length});});
app.delete('/api/banner/campanas/:id/image/:file',(req,res)=>{try{const fp=path.join(CAMPANA_BANNER_DIR,req.params.file);if(fs.existsSync(fp))fs.unlinkSync(fp);}catch(e){}const d=safeReadJson(DATA_BANNER_FILE,{sets:[],campanas:[],config:{}});const c=d.campanas.find(c=>c.id==req.params.id);if(c&&c.images)c.images=c.images.filter(i=>i.file!==req.params.file);d.updatedAt=new Date().toISOString();safeWriteJson(DATA_BANNER_FILE,d);res.json({ok:true});});

// ════════════════════════════════════════════════════════════════
// ENCUESTA
// ════════════════════════════════════════════════════════════════
app.get('/api/encuesta/preguntas',async(req,res)=>{try{const p=await getPool();const r=await p.request().query('SELECT id,pregunta,activo,orden,modo,establecimiento,fecha_creacion,tipo,opciones,seleccion_multiple FROM dbo.pos_encuesta_pregunta ORDER BY orden ASC,id ASC');res.json(r.recordset);}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/encuesta/preguntas',async(req,res)=>{try{const{pregunta,activo,orden,modo,establecimiento,tipo,opciones,seleccion_multiple}=req.body;const p=await getPool();await p.request().input('pregunta',sql.NVarChar(500),pregunta).input('activo',sql.Bit,activo?1:0).input('orden',sql.Int,orden||0).input('modo',sql.NVarChar(20),modo||'ALEATORIA').input('establecimiento',sql.NVarChar(sql.MAX),establecimiento||null).input('tipo',sql.NVarChar(20),tipo||'EMOJIS').input('opciones',sql.NVarChar(sql.MAX),opciones||null).input('seleccion_multiple',sql.Bit,seleccion_multiple?1:0).query('INSERT INTO dbo.pos_encuesta_pregunta(pregunta,activo,orden,modo,establecimiento,tipo,opciones,seleccion_multiple) VALUES(@pregunta,@activo,@orden,@modo,@establecimiento,@tipo,@opciones,@seleccion_multiple)');res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.put('/api/encuesta/preguntas/:id',async(req,res)=>{try{const{pregunta,activo,orden,modo,establecimiento,tipo,opciones,seleccion_multiple}=req.body;const p=await getPool();await p.request().input('id',sql.Int,req.params.id).input('pregunta',sql.NVarChar(500),pregunta).input('activo',sql.Bit,activo?1:0).input('orden',sql.Int,orden||0).input('modo',sql.NVarChar(20),modo||'ALEATORIA').input('establecimiento',sql.NVarChar(sql.MAX),establecimiento||null).input('tipo',sql.NVarChar(20),tipo||'EMOJIS').input('opciones',sql.NVarChar(sql.MAX),opciones||null).input('seleccion_multiple',sql.Bit,seleccion_multiple?1:0).query('UPDATE dbo.pos_encuesta_pregunta SET pregunta=@pregunta,activo=@activo,orden=@orden,modo=@modo,establecimiento=@establecimiento,tipo=@tipo,opciones=@opciones,seleccion_multiple=@seleccion_multiple WHERE id=@id');res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.delete('/api/encuesta/preguntas/:id',async(req,res)=>{try{const p=await getPool();await p.request().input('id',sql.Int,req.params.id).query('DELETE FROM dbo.pos_encuesta_pregunta WHERE id=@id');res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/encuesta/respuestas',async(req,res)=>{try{const{desde,hasta,establecimiento,pregunta}=req.query;const p=await getPool();const r=p.request();let where='WHERE 1=1';if(desde){where+=' AND fecha>=@desde';r.input('desde',sql.DateTime,new Date(desde));}if(hasta){where+=' AND fecha<=@hasta';r.input('hasta',sql.DateTime,new Date(hasta+' 23:59:59'));}if(establecimiento){where+=' AND r.establecimiento=@est';r.input('est',sql.NVarChar(50),establecimiento);}if(pregunta){where+=' AND id_pregunta=@pq';r.input('pq',sql.Int,parseInt(pregunta));}const result=await r.query(`SELECT r.id,r.fecha,r.id_pregunta,r.pregunta_texto,r.identificacion,r.nombre_cliente,r.calificacion,r.descripcion,r.comentario,r.establecimiento,ISNULL(e.nombre,r.establecimiento) AS nombre_establecimiento,r.pto_emision,r.cajero,r.numero_factura,p.tipo FROM dbo.pos_encuesta_respuesta r LEFT JOIN dbo.pos_encuesta_pregunta p ON r.id_pregunta=p.id LEFT JOIN dbo.core_establecimiento e ON e.establecimiento=r.establecimiento ${where} ORDER BY r.fecha DESC`);res.json(result.recordset);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/encuesta/establecimientos',async(req,res)=>{try{const p=await getPool();const r=await p.request().query("SELECT DISTINCT r.establecimiento,ISNULL(e.nombre,r.establecimiento) AS nombre FROM dbo.pos_encuesta_respuesta r LEFT JOIN dbo.core_establecimiento e ON e.establecimiento=r.establecimiento WHERE e.almacen LIKE '%ARDP%' AND e.almacen NOT IN('ARDP-0002','ARDP-0007','ARDP-0155') ORDER BY nombre");res.json(r.recordset);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/establecimientos',async(req,res)=>{try{const p=await getPool();const result=await p.request().query("SELECT establecimiento,nombre FROM dbo.core_establecimiento WHERE almacen LIKE '%ARDP%' AND almacen NOT IN('ARDP-0002','ARDP-0007','ARDP-0155') ORDER BY nombre");res.json(result.recordset);}catch(e){res.status(500).json({error:e.message});}});

// ════════════════════════════════════════════════════════════════
// AUTH - LOGIN / LOGOUT
// ════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  try {
    const p = await getPool();
    const r = await p.request()
      .input('usuario',  sql.VarChar(50),  usuario)
      .input('password', sql.VarChar(255), password)
      .query(`SELECT u.id, u.nombre, u.usuario, u.id_rol, r.nombre AS rol
              FROM dbo.admin_publicidad_usuarios u
              LEFT JOIN dbo.admin_publicidad_roles r ON r.id = u.id_rol
              WHERE u.usuario=@usuario AND u.password=@password AND u.activo=1`);
    if (r.recordset.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    req.session.usuario = r.recordset[0];
    res.json({ ok: true, nombre: r.recordset[0].nombre, rol: r.recordset[0].rol, id_rol: r.recordset[0].id_rol });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/check', (req, res) => {
  if (req.session && req.session.usuario)
    return res.json({ autenticado: true, nombre: req.session.usuario.nombre, rol: req.session.usuario.rol, id_rol: req.session.usuario.id_rol });
  res.json({ autenticado: false });
});

// ════════════════════════════════════════════════════════════════
// CONFIGURACIÓN ENCUESTA
// ════════════════════════════════════════════════════════════════
app.get('/api/encuesta/config', async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .query("SELECT valor FROM dbo.core_parametro WHERE identificador = 'TIEMPO_ENCUESTA'");
    const valor = r.recordset.length > 0 ? parseInt(r.recordset[0].valor) : 30;
    res.json({ tiempo_encuesta: valor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/encuesta/config', async (req, res) => {
  try {
    const { tiempo_encuesta } = req.body;
    if (!tiempo_encuesta || isNaN(tiempo_encuesta) || tiempo_encuesta < 5) {
      return res.status(400).json({ error: 'Tiempo inválido, mínimo 5 segundos' });
    }
    const p = await getPool();
    await p.request()
      .input('valor', sql.NVarChar(50), tiempo_encuesta.toString())
      .query("UPDATE dbo.core_parametro SET valor=@valor, fecha_modificacion=GETDATE() WHERE identificador='TIEMPO_ENCUESTA'");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Middleware: requiere sesión activa
function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  res.status(401).json({ error: 'No autenticado' });
}
// Middleware: solo roles con acceso a carrusel/banner (admin=1, Marketing=2)
function requireMarketing(req, res, next) {
  const id_rol = req.session && req.session.usuario && req.session.usuario.id_rol;
  if (id_rol === 1 || id_rol === 2) return next();
  res.status(403).json({ error: 'Acceso denegado' });
}
// Middleware: solo roles con acceso a encuestas (admin=1, Retail=3)
function requireRetail(req, res, next) {
  const id_rol = req.session && req.session.usuario && req.session.usuario.id_rol;
  if (id_rol === 1 || id_rol === 3) return next();
  res.status(403).json({ error: 'Acceso denegado' });
}

// Proteger APIs de carrusel y banner (Marketing + Admin)
app.use(['/api/data','/api/config','/api/sets','/api/campanas',
         '/api/banner/data','/api/banner/config','/api/banner/sets','/api/banner/campanas'],
  requireAuth, requireMarketing);

// Proteger APIs de encuesta (Retail + Admin)
app.use(['/api/encuesta/preguntas','/api/encuesta/respuestas','/api/encuesta/establecimientos'],
  requireAuth, requireRetail);

// ── Manejador global de errores (multer y otros) ─────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR GLOBAL] url:', req.url, '| code:', err.code, '| msg:', err.message);
  if (err && err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'Una o más imágenes superan el límite de 1 MB' });
  res.status(500).json({ error: err.message || 'Error interno' });
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log('===========================================');
  console.log('  Servidor Carrusel POS corriendo en :'+PORT);
  console.log('===========================================');
});
