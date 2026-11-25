export function distributionFixture(){
  const op=(id,kind,personId,amount,extra={})=>({id,label:`PRIVATE-OPERATION-${id}`,kind,personId,amount,deductible:kind!=='dividend',employeeSSRate:0,employerSSRate:0,withholdingRate:null,vatRate:null,taxTreatmentConfirmed:false,...extra});
  return {version:1,people:[{personId:'person-a',taxRegion:'catalonia'},{personId:'person-b',taxRegion:'other'}],scenarios:[{scenarioId:'scenario-a',operations:[
    op('op-salary','salary','person-a',2200,{employeeSSRate:6.5,employerSSRate:30}),op('op-admin','administrator','person-a',1300,{withholdingRate:35}),
    op('op-div-a','dividend','person-a',700),op('op-pro','professional','person-b',1500,{vatRate:21,withholdingRate:15}),
    op('op-div-b','dividend','person-b',300),op('op-expense','expense',null,500,{vatRate:21})]}]};
}
