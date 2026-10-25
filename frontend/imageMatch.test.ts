import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareEvidence,type ImageEvidence} from './imageMatch';
test('absolute image gates reject even the highest ranked unrelated picture',()=>{
 const reference:ImageEvidence={embedding:[1,0],hash:Array(64).fill(1),contrast:0.2};
 assert(compareEvidence(reference,reference,'same').accepted);
 assert(!compareEvidence(reference,{...reference,embedding:[0,1]},'different').accepted);
 assert(!compareEvidence(reference,{...reference,hash:Array(64).fill(0)},'same-category-different-shape').accepted);
 assert(!compareEvidence(reference,{...reference,contrast:0},'blank').accepted);
 assert(!compareEvidence(reference,{...reference,embedding:[NaN,0]},'invalid').accepted);
});
