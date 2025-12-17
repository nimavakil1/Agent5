/**
 * SeasonalCalendar Service
 *
 * Provides seasonal context for purchasing decisions including:
 * - Chinese New Year dates (lunar calendar calculation)
 * - Belgian/EU retail seasons
 * - Holiday calendars and their demand impact
 */

class SeasonalCalendar {
  constructor() {
    // Pre-computed CNY dates (first day of lunar new year)
    // These are accurate for 2024-2030
    this.cnyDates = {
      2024: new Date('2024-02-10'),
      2025: new Date('2025-01-29'),
      2026: new Date('2026-02-17'),
      2027: new Date('2027-02-06'),
      2028: new Date('2028-01-26'),
      2029: new Date('2029-02-13'),
      2030: new Date('2030-02-03'),
    };

    // Belgian retail seasons with demand multipliers
    // Only seasons relevant to office supplies / e-commerce importing from China
    this.belgianSeasons = [
      {
        name: 'Back to School',
        startDay: 15, startMonth: 7, // Aug 15
        endDay: 15, endMonth: 8,     // Sep 15
        categories: ['office_supplies', 'school_supplies', 'bags', 'electronics'],
        demandMultiplier: 1.8,
        description: 'School supplies and office equipment surge',
      },
      {
        name: 'Black Friday Week',
        startDay: 20, startMonth: 10, // Nov 20
        endDay: 30, endMonth: 10,     // Nov 30
        categories: ['all'],
        demandMultiplier: 2.5,
        description: 'Major promotional period across all categories',
      },
      {
        name: 'Christmas Shopping',
        startDay: 1, startMonth: 11,  // Dec 1
        endDay: 24, endMonth: 11,     // Dec 24
        categories: ['gifts', 'electronics', 'office_supplies'],
        demandMultiplier: 2.2,
        description: 'Year-end gift giving and corporate purchases',
      },
      {
        name: 'New Year & Back to Office',
        startDay: 3, startMonth: 0,   // Jan 3
        endDay: 31, endMonth: 0,      // Jan 31
        categories: ['office_supplies', 'furniture', 'electronics', 'ergonomic', 'all'],
        demandMultiplier: 1.5,
        description: 'Post-Christmas sales and office restocking after holidays',
      },
    ];

    // Belgian public holidays
    this.belgianHolidays = [
      { name: 'New Year', month: 0, day: 1 },
      { name: 'Easter Monday', month: 'easter', dayOffset: 1 },
      { name: 'Labour Day', month: 4, day: 1 },
      { name: 'Ascension Day', month: 'easter', dayOffset: 39 },
      { name: 'Whit Monday', month: 'easter', dayOffset: 50 },
      { name: 'National Day', month: 6, day: 21 },
      { name: 'Assumption', month: 7, day: 15 },
      { name: 'All Saints', month: 10, day: 1 },
      { name: 'Armistice Day', month: 10, day: 11 },
      { name: 'Christmas', month: 11, day: 25 },
    ];
  }

  /**
   * Get Chinese New Year date for a given year
   */
  getCNYDate(year) {
    if (this.cnyDates[year]) {
      return this.cnyDates[year];
    }
    // Fallback: estimate based on pattern (late Jan to mid Feb)
    return new Date(year, 0, 28); // Jan 28 as rough estimate
  }

  /**
   * Get Chinese New Year factory closure period
   * Factories typically close 2 weeks before CNY and reopen 2 weeks after
   */
  getCNYClosurePeriod(year) {
    const cnyDate = this.getCNYDate(year);

    // Factory closure starts ~10 days before CNY
    const closureStart = new Date(cnyDate);
    closureStart.setDate(closureStart.getDate() - 10);

    // Factories reopen ~14 days after CNY, but not at full capacity for another week
    const closureEnd = new Date(cnyDate);
    closureEnd.setDate(closureEnd.getDate() + 14);

    // Full recovery typically 21 days after CNY
    const fullRecovery = new Date(cnyDate);
    fullRecovery.setDate(fullRecovery.getDate() + 21);

    return {
      cnyDate,
      closureStart,
      closureEnd,
      fullRecovery,
      totalClosureDays: Math.ceil((closureEnd - closureStart) / (1000 * 60 * 60 * 24)),
      recoveryDays: Math.ceil((fullRecovery - closureEnd) / (1000 * 60 * 60 * 24)),
      description: `CNY ${year}: Factories close ${closureStart.toDateString()} to ${closureEnd.toDateString()}, full recovery by ${fullRecovery.toDateString()}`,
    };
  }

  /**
   * Calculate order deadline for CNY
   * Given shipping time and supplier lead time, when is the last day to place an order?
   */
  getCNYOrderDeadline(year, shippingDays = 40, supplierLeadDays = 7) {
    const closure = this.getCNYClosurePeriod(year);

    // Order must arrive before closure starts
    const mustArriveBy = closure.closureStart;

    // Work backwards: arrival date - shipping time - supplier lead time
    const orderDeadline = new Date(mustArriveBy);
    orderDeadline.setDate(orderDeadline.getDate() - shippingDays - supplierLeadDays);

    return {
      orderDeadline,
      mustArriveBy,
      closure,
      warning: orderDeadline < new Date() ? 'URGENT: Order deadline has passed!' : null,
      daysUntilDeadline: Math.ceil((orderDeadline - new Date()) / (1000 * 60 * 60 * 24)),
    };
  }

  /**
   * Calculate Easter date for a given year (Computus algorithm)
   */
  getEasterDate(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
    const day = ((h + l - 7 * m + 114) % 31) + 1;

    return new Date(year, month, day);
  }

  /**
   * Get active seasons for a given date
   */
  getActiveSeasons(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const easter = this.getEasterDate(year);

    const activeSeasons = [];

    for (const season of this.belgianSeasons) {
      let startDate, endDate;

      if (season.startMonth === 'easter') {
        startDate = new Date(easter);
        startDate.setDate(startDate.getDate() + season.startDay);
      } else {
        startDate = new Date(year, season.startMonth, season.startDay);
      }

      if (season.endMonth === 'easter') {
        endDate = new Date(easter);
        endDate.setDate(endDate.getDate() + season.endDay);
      } else {
        endDate = new Date(year, season.endMonth, season.endDay);
      }

      // Handle seasons that span year boundary
      if (endDate < startDate) {
        endDate.setFullYear(endDate.getFullYear() + 1);
      }

      if (date >= startDate && date <= endDate) {
        activeSeasons.push({
          ...season,
          startDate,
          endDate,
          daysRemaining: Math.ceil((endDate - date) / (1000 * 60 * 60 * 24)),
        });
      }
    }

    return activeSeasons;
  }

  /**
   * Get upcoming seasons within a date range
   */
  getUpcomingSeasons(startDate = new Date(), daysAhead = 90) {
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + daysAhead);

    const year = startDate.getFullYear();
    const nextYear = year + 1;
    const easter = this.getEasterDate(year);
    const easterNext = this.getEasterDate(nextYear);

    const upcomingSeasons = [];

    for (const season of this.belgianSeasons) {
      for (const y of [year, nextYear]) {
        const easterDate = y === year ? easter : easterNext;
        let seasonStart, seasonEnd;

        if (season.startMonth === 'easter') {
          seasonStart = new Date(easterDate);
          seasonStart.setDate(seasonStart.getDate() + season.startDay);
        } else {
          seasonStart = new Date(y, season.startMonth, season.startDay);
        }

        if (season.endMonth === 'easter') {
          seasonEnd = new Date(easterDate);
          seasonEnd.setDate(seasonEnd.getDate() + season.endDay);
        } else {
          seasonEnd = new Date(y, season.endMonth, season.endDay);
        }

        if (seasonStart >= startDate && seasonStart <= endDate) {
          upcomingSeasons.push({
            ...season,
            year: y,
            startDate: seasonStart,
            endDate: seasonEnd,
            daysUntilStart: Math.ceil((seasonStart - startDate) / (1000 * 60 * 60 * 24)),
          });
        }
      }
    }

    // Sort by start date
    upcomingSeasons.sort((a, b) => a.startDate - b.startDate);

    return upcomingSeasons;
  }

  /**
   * Get demand multiplier for a product category on a given date
   */
  getDemandMultiplier(category, date = new Date()) {
    const activeSeasons = this.getActiveSeasons(date);

    let multiplier = 1.0;

    for (const season of activeSeasons) {
      if (season.categories.includes('all') || season.categories.includes(category.toLowerCase())) {
        // Use the highest multiplier if multiple seasons apply
        multiplier = Math.max(multiplier, season.demandMultiplier);
      }
    }

    return multiplier;
  }

  /**
   * Get Belgian holidays for a year
   */
  getHolidays(year) {
    const easter = this.getEasterDate(year);
    const holidays = [];

    for (const holiday of this.belgianHolidays) {
      let date;

      if (holiday.month === 'easter') {
        date = new Date(easter);
        date.setDate(date.getDate() + holiday.dayOffset);
      } else {
        date = new Date(year, holiday.month, holiday.day);
      }

      holidays.push({
        name: holiday.name,
        date,
      });
    }

    return holidays.sort((a, b) => a.date - b.date);
  }

  /**
   * Get the NEXT upcoming CNY closure period (always in the future)
   */
  getNextCNYClosurePeriod(date = new Date()) {
    const year = date.getFullYear();

    // Check this year's CNY first
    const cnyThisYear = this.getCNYClosurePeriod(year);

    // If this year's CNY closure hasn't started yet, use it
    if (date < cnyThisYear.closureStart) {
      return cnyThisYear;
    }

    // Otherwise, use next year's CNY
    return this.getCNYClosurePeriod(year + 1);
  }

  /**
   * Check if supply chain is impacted (CNY closure or major holiday)
   * Always checks the NEXT upcoming CNY (always in the future relative to today)
   */
  isSupplyChainImpacted(date = new Date()) {
    const year = date.getFullYear();

    // Get the next upcoming CNY (always in the future)
    const cny = this.getNextCNYClosurePeriod(date);

    // Check if within CNY closure
    if (date >= cny.closureStart && date <= cny.fullRecovery) {
      return {
        impacted: true,
        reason: 'Chinese New Year factory closure',
        severity: date <= cny.closureEnd ? 'critical' : 'moderate',
        resumeDate: cny.fullRecovery,
        details: cny,
      };
    }

    // Check if CNY is upcoming (need to order now)
    const daysUntilClosure = Math.ceil((cny.closureStart - date) / (1000 * 60 * 60 * 24));
    if (daysUntilClosure > 0 && daysUntilClosure <= 60) {
      return {
        impacted: true,
        reason: 'Chinese New Year approaching - order now',
        severity: daysUntilClosure <= 30 ? 'high' : 'moderate',
        closureStart: cny.closureStart,
        daysUntilClosure,
        details: cny,
      };
    }

    return {
      impacted: false,
      nextClosure: cny.closureStart,
      daysUntilNextClosure: daysUntilClosure,
    };
  }

  /**
   * Get a comprehensive seasonal forecast
   */
  getSeasonalForecast(startDate = new Date(), monthsAhead = 6) {
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + monthsAhead);

    const forecast = {
      period: { start: startDate, end: endDate },
      supplyChainAlerts: [],
      upcomingSeasons: [],
      monthlyMultipliers: {},
    };

    // Check supply chain for each month
    const checkDate = new Date(startDate);
    while (checkDate <= endDate) {
      const year = checkDate.getFullYear();
      const impact = this.isSupplyChainImpacted(checkDate);

      if (impact.impacted) {
        forecast.supplyChainAlerts.push({
          date: new Date(checkDate),
          ...impact,
        });
      }

      // Move to next month
      checkDate.setMonth(checkDate.getMonth() + 1);
    }

    // Get upcoming seasons
    forecast.upcomingSeasons = this.getUpcomingSeasons(startDate, monthsAhead * 30);

    // Calculate average monthly multipliers
    for (let m = 0; m < monthsAhead; m++) {
      const monthDate = new Date(startDate);
      monthDate.setMonth(monthDate.getMonth() + m);
      const monthKey = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;

      const activeSeasons = this.getActiveSeasons(monthDate);
      const maxMultiplier = activeSeasons.length > 0
        ? Math.max(...activeSeasons.map(s => s.demandMultiplier))
        : 1.0;

      forecast.monthlyMultipliers[monthKey] = {
        multiplier: maxMultiplier,
        seasons: activeSeasons.map(s => s.name),
      };
    }

    return forecast;
  }
}

// Singleton instance
let calendarInstance = null;

function getSeasonalCalendar() {
  if (!calendarInstance) {
    calendarInstance = new SeasonalCalendar();
  }
  return calendarInstance;
}

module.exports = {
  SeasonalCalendar,
  getSeasonalCalendar,
};
