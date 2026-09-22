/** Format local Korean numbers while typing, without changing stored originals. */
export function formatPilotPhone(value){
 if(!/^[\d\s()-]*$/.test(value))return value;
 const digits=value.replace(/\D/g,'');
 if(!digits.startsWith('0')||digits.length>11)return value;
 const prefix=digits.startsWith('02')?2:3;
 if(digits.length<=prefix)return digits;
 const rest=digits.slice(prefix);
 if(rest.length<=3)return digits.slice(0,prefix)+'-'+rest;
 const middle=rest.length>7?4:3;
 return digits.slice(0,prefix)+'-'+rest.slice(0,middle)+(rest.length>middle?'-'+rest.slice(middle):'');
}
