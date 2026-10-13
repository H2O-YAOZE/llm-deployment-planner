'use strict';
// V4 planning model from config + pinned SGLang runtime. No benchmark factors.
(function(root){
 function profile(s,m){
  const p=m.cacheProfile;
  if(p?.kind==='sparse-mla'){
   const scale=s.layers/m.layers,indexLayers=p.indexerLayers*scale,K=p.indexTopk,width=s.kvWidth,bytes=s.kvBytes;
   const coef=2*s.qHeads*(s.qkDim+s.vDim)*s.attentionFraction,indexCoef=2*p.indexHeads*p.indexHeadDim*indexLayers;
   const storeSlope=bytes*(width*s.layers+p.indexHeadDim*indexLayers),readSlope=bytes*p.indexHeadDim*indexLayers,selectedSlope=bytes*width*s.layers;
   const pairs=(n,w)=>n<=w?n*(n+1)/2:w*(w+1)/2+(n-w)*w;
   const cache=n=>storeSlope*n,read=n=>readSlope*n+selectedSlope*Math.min(n,K);
   const attention=(n,prefill)=>prefill?indexCoef*n*(n+1)/2+coef*s.layers*pairs(n,K):indexCoef*n+coef*s.layers*Math.min(n,K);
   return {kind:p.kind,c4:0,c128:0,W:0,K,selectionWindow:K,width,bytes,fixed:0,stateElements:0,storeSlope,windowSlope:0,readSlope,selectedSlope,fullCoef:indexCoef,windowCoef:0,selectedCoef:coef*s.layers,indexCoef,indexLayers,ops:0,cache,read,attention};
  }
  if(p?.kind!=='deepseek-v4')return null;
  const scale=s.layers/m.layers,c4=p.compressRatios.filter(r=>r===4).length*scale,c128=p.compressRatios.filter(r=>r===128).length*scale;
  const W=p.slidingWindow,K=p.indexTopk,width=s.kvWidth,bytes=s.kvBytes;
  // Runtime keeps one shared K/V vector, compressed index keys, and FP32
  // compressor state. One extra block per compressed layer covers rounding.
  const stateElements=c4*4*4*(width+p.indexHeadDim)+c128*128*2*width;
  const fixed=stateElements*4+(c4+c128)*width*bytes+c4*p.indexHeadDim*bytes;
  const storeSlope=bytes*(width*(c4/4+c128/128)+p.indexHeadDim*c4/4);
  const windowSlope=bytes*width*s.layers;
  const readSlope=bytes*(width*c128/128+p.indexHeadDim*c4/4);
  const selectedSlope=bytes*width*c4/4;
  const coef=2*s.qHeads*(s.qkDim+s.vDim)*s.attentionFraction;
  const indexCoef=2*p.indexHeads*p.indexHeadDim*c4/4;
  const fullCoef=coef*c128/128+indexCoef,windowCoef=coef*s.layers,selectedCoef=coef*c4/4;
  // Explicit coarse recurrence allowance; projection FLOPs remain in activeB.
  const ops=stateElements*8;
  const pairs=(n,w)=>n<=w?n*(n+1)/2:w*(w+1)/2+(n-w)*w;
  const cache=n=>storeSlope*n+windowSlope*Math.min(n,W)+fixed;
  const read=n=>readSlope*n+windowSlope*Math.min(n,W)+selectedSlope*Math.min(n,4*K)+fixed;
  const attention=(n,prefill)=>prefill?fullCoef*n*(n+1)/2+windowCoef*pairs(n,W)+selectedCoef*pairs(n,4*K)+ops*n:fullCoef*n+windowCoef*Math.min(n,W)+selectedCoef*Math.min(n,4*K)+ops;
  return {kind:p.kind,c4,c128,W,K,selectionWindow:4*K,width,bytes,fixed,stateElements,storeSlope,windowSlope,readSlope,selectedSlope,fullCoef,windowCoef,selectedCoef,indexCoef,ops,cache,read,attention};
 }
 const api={profile};root.CompressedAttention=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
