import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindFileDragOverlay} from './fileDragOverlay.ts';

function setup() {
  const target = Object.assign(new EventTarget(), {document: Object.assign(new EventTarget(), {hidden:false})});
  let active = false;
  const dispose = bindFileDragOverlay(target as unknown as Window, value => {active=value;});
  const emit = (name:string, props:Record<string,unknown>={}) => target.dispatchEvent(Object.assign(new Event(name),props));
  const enter = () => emit('dragenter',{dataTransfer:{types:['Files']}});
  return {target,dispose,emit,enter,active:()=>active};
}

test('drop clears overlay even after nested drag enters', () => {
  const s=setup();
  try {s.enter();s.enter();assert.equal(s.active(),true);s.emit('drop');assert.equal(s.active(),false);} finally{s.dispose();}
});
test('text drags do not activate the file overlay', () => {
  const s=setup();
  try{s.emit('dragenter',{dataTransfer:{types:['text/plain']}});assert.equal(s.active(),false);}finally{s.dispose();}
});
for(const event of ['dragend','blur','pointerdown','keydown','dragleave']) {
  test(`${event} cancels a pending overlay`,()=>{
    const s=setup();
    try{s.enter();s.emit(event,{key:'Escape',relatedTarget:null});assert.equal(s.active(),false);}finally{s.dispose();}
  });
}
test('hidden tab cancels the overlay',()=>{
  const s=setup();
  try{s.enter();s.target.document.hidden=true;s.target.document.dispatchEvent(new Event('visibilitychange'));assert.equal(s.active(),false);}finally{s.dispose();}
});
test('missing terminal drag events cannot leave overlay stuck',async()=>{
  const s=setup();
  try{s.enter();await new Promise(resolve=>setTimeout(resolve,1600));assert.equal(s.active(),false);}finally{s.dispose();}
});
test('cleanup removes drag listeners',()=>{
  const s=setup();s.dispose();s.enter();assert.equal(s.active(),false);
});
