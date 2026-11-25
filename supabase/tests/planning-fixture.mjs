export function planningFixture() {
  return {version:1,settings:{asOf:'2025-11-01',horizon:'2025-12-31',taxYear:2025,corporateTaxRate:15,corporateTaxConfirmed:false,
    legalReservePending:250,minimumCash:1000,cashBalanceOverride:null,profitOverride:null,pendingCosts:'gross',
    people:[{id:'person-a',name:'Ana',taxProfileKnown:true,externalSalary:28000,employeeSS:1800,retaAnnual:960,
      otherGeneralIncome:0,employmentExpense:2000,otherSavings:0,sharePercent:70,isShareholder:true,employerContributionRate:0,retaPeriod:'initial',retaYear:2025},
    {id:'person-b',name:'Bea',taxProfileKnown:false,externalSalary:0,employeeSS:0,retaAnnual:0,
      otherGeneralIncome:0,employmentExpense:2000,otherSavings:0,sharePercent:30,isShareholder:true,employerContributionRate:0,retaPeriod:'ordinary',retaYear:2025}],
    collectionDates:{'invoice-fixture':'2025-11-30'}},
    items:[{id:'forecast-a',label:'Servicio mensual',kind:'expense',amountGross:120,vatRate:20,vatDeductible:false,treatment:'operating',recurrence:'monthly',startDate:'2025-11-30',endDate:null,active:true,linkedRecordIds:[]}],
    scenarios:[{id:'scenario-a',name:'Plan de prueba',people:[{personId:'person-a',workGross:3500,dividendGross:700},{personId:'person-b',workGross:1500,dividendGross:300}],dividendDate:'2026-06-15',notes:'PRIVATE-SCENARIO-NOTE'}]};
}
