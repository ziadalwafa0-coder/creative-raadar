import {test} from 'node:test';
import assert from 'node:assert/strict';
import {amazonProductName} from './amazonProductName';
test('Egyptian catalogue names become Amazon commerce search terms with their distinguishing features',()=>{
 for(const [name,query]of [
  ['جزامة ٩ دور بغطاء','9 Tier Shoe Rack with Cover'],
  ['جزامة خشب مودرن خمس أدوار','5 Tier Wooden Shoe Rack'],
  ['ستاند ملابس زوجي بعجل','Double Rod Clothes Rack with Wheels'],
  ['جهاز خيط الأسنان المائي','Water Flosser'],
  ['مكنسه كهربائيه للعربيه','Car Vacuum Cleaner'],
  ['حوامل غسالة سيليكون مانعة للانزلاق','Washing Machine Anti Vibration Pads'],
  ['شنيور دقاق ٧٥٠ وات مع شنطة عدة 146 قطعة','750W Hammer Drill with Tool Kit 146 Pieces'],
  ['مانع ناموس للشباك ١٣٠*١٥٠ سم','Window Mosquito Screen Mesh 130 x 150 cm'],
  ['كمبروسر 12 فولت 2 بستم','12V Dual Cylinder Tire Inflator Air Compressor'],
 ] as const)assert.equal(amazonProductName(name),query,name);
});
test('model and known brand survive optimization and unknown products use the translator',()=>{
 assert.equal(amazonProductName('خلاط Silver Crest SC-1589 مع مطحنة'),'Silver Crest Blender with Grinder SC-1589');
 assert.equal(amazonProductName('منتج جديد غير معروف'),undefined);
 assert.equal(amazonProductName('غالق الباب الأوتوماتيك'),'Automatic Door Closer');
 assert.equal(amazonProductName('شنيور دقاق Bosch 750 وات'),'750W Hammer Drill Bosch');
});
