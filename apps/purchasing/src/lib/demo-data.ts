// Seed data for the purchasing demo.
//
// EVERYTHING IN THIS FILE IS INVENTED. Vendors, supplier contacts, jobs,
// requestors, addresses, phone numbers and email addresses are placeholders so
// the dashboard looks populated during a walkthrough. Replace this one file
// with real lists (or a real API call) when the prototype graduates.
//
// Email addresses here are never used to send anything — see email-draft.ts.

import { formatPoNumber, FIRST_DEMO_PO_NUMBER } from './po';
import type { DemoState, Job, PurchaseRequest, Requestor, Vendor } from './types';

export const STATE_VERSION = 1;

export const DEMO_VENDORS: Vendor[] = [
  {
    id: 'v-hvsupply',
    name: 'Hudson Valley Electric Supply',
    regions: ['North', 'Central'],
    specialty: 'Wire, conduit, fittings — same-day counter pickup',
    contact: {
      name: 'Counter Desk',
      email: 'orders@example-hvsupply.test',
      phone: '(555) 0100',
      branch: 'Poughkeepsie, NY',
    },
  },
  {
    id: 'v-metro',
    name: 'Metro Electrical Distributors',
    regions: ['Central', 'South'],
    specialty: 'Gear, panels, breakers — will-call and delivery',
    contact: {
      name: 'Inside Sales',
      email: 'sales@example-metrodist.test',
      phone: '(555) 0111',
      branch: 'Yonkers, NY',
    },
  },
  {
    id: 'v-parkway',
    name: 'Parkway Lighting & Controls',
    regions: ['Statewide'],
    specialty: 'Fixtures, drivers, lighting controls, gear packages',
    contact: {
      name: 'Project Desk',
      email: 'projects@example-parkwaylighting.test',
      phone: '(555) 0122',
      branch: 'Elmsford, NY',
    },
  },
  {
    id: 'v-harbor',
    name: 'Harbor Point Supply Co.',
    regions: ['South'],
    specialty: 'General electrical, close to the downtown jobs',
    contact: {
      name: 'Will Call',
      email: 'willcall@example-harborpoint.test',
      phone: '(555) 0133',
      branch: 'Brooklyn, NY',
    },
  },
  {
    id: 'v-northline',
    name: 'Northline Industrial Hardware',
    regions: ['North'],
    specialty: 'Strut, anchors, fasteners, jobsite consumables',
    contact: {
      name: 'Branch Manager',
      email: 'branch@example-northline.test',
      phone: '(555) 0144',
      branch: 'Newburgh, NY',
    },
  },
  {
    id: 'v-tristate',
    name: 'Tri-State Tool Rental',
    regions: ['Statewide'],
    specialty: 'Rental tools, lifts, temp power equipment',
    contact: {
      name: 'Rental Counter',
      email: 'rentals@example-tristatetool.test',
      phone: '(555) 0155',
      branch: 'Mount Vernon, NY',
    },
  },
];

export const DEMO_JOBS: Job[] = [
  {
    id: 'j-24118',
    number: '24-118',
    name: 'Riverside Medical Office Fit-Out',
    address: '812 Riverside Dr, Poughkeepsie, NY 12601',
    region: 'North',
  },
  {
    id: 'j-24132',
    number: '24-132',
    name: 'Eastgate Warehouse Lighting Retrofit',
    address: '45 Eastgate Industrial Pkwy, Newburgh, NY 12550',
    region: 'North',
  },
  {
    id: 'j-24140',
    number: '24-140',
    name: 'Clearwater Apartments — Service Upgrade',
    address: '210 Clearwater Ave, Yonkers, NY 10701',
    region: 'Central',
  },
  {
    id: 'j-24151',
    number: '24-151',
    name: 'Municipal Garage Generator Tie-In',
    address: '77 Depot St, Elmsford, NY 10523',
    region: 'Central',
  },
  {
    id: 'j-24163',
    number: '24-163',
    name: 'Harbor Point Retail Build-Out',
    address: '1400 Harbor Point Blvd, Brooklyn, NY 11231',
    region: 'South',
  },
  {
    id: 'j-24170',
    number: '24-170',
    name: 'Service Truck Stock / Shop',
    address: '9 Shop Rd, Mount Vernon, NY 10550',
    region: 'South',
  },
];

export const DEMO_REQUESTORS: Requestor[] = [
  { id: 'r-mcarter', name: 'Mike Carter', role: 'Foreman' },
  { id: 'r-druiz', name: 'Danny Ruiz', role: 'Foreman' },
  { id: 'r-tnolan', name: 'Tom Nolan', role: 'Foreman' },
  { id: 'r-sbrennan', name: 'Sara Brennan', role: 'Office' },
  { id: 'r-lpatel', name: 'Leena Patel', role: 'Project Manager' },
];

/** Fixed clock for the seed rows so the demo renders identically every load. */
const SEED_TODAY = '2026-08-05';

function at(dayOffset: number, hhmm: string): string {
  const base = new Date(`${SEED_TODAY}T00:00:00.000Z`).getTime();
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(base + dayOffset * 86_400_000 + h * 3_600_000 + m * 60_000).toISOString();
}

function day(dayOffset: number): string {
  return new Date(
    new Date(`${SEED_TODAY}T00:00:00.000Z`).getTime() + dayOffset * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Historical POs sit below FIRST_DEMO_PO_NUMBER so the first PO a demo user
 * generates is exactly DEMO-52901, as specified.
 */
function historicalPo(offsetBelowFirst: number): string {
  return formatPoNumber(FIRST_DEMO_PO_NUMBER - offsetBelowFirst);
}

export const DEMO_REQUESTS: PurchaseRequest[] = [
  {
    id: 'PR-1041',
    status: 'Completed',
    poNumber: historicalPo(7),
    requestorId: 'r-mcarter',
    jobId: 'j-24118',
    vendorId: 'v-hvsupply',
    priority: 'Standard',
    neededBy: day(-14),
    estimatedCost: 2480,
    notes: 'Rough-in material for the second floor exam rooms.',
    lines: [
      { id: 'l-1041-1', quantity: 40, unit: 'ea', description: '4 sq box w/ mud ring', stockNumber: 'SQ4-1B' },
      { id: 'l-1041-2', quantity: 2500, unit: 'ft', description: '#12 THHN copper, black', stockNumber: 'THHN12-BK' },
      { id: 'l-1041-3', quantity: 30, unit: 'ea', description: '1/2" EMT connector, steel set-screw' },
    ],
    createdAt: at(-21, '07:40'),
    updatedAt: at(-11, '15:05'),
    history: [
      { id: 'h-1041-1', at: at(-21, '07:40'), actor: 'Mike Carter', action: 'Created', detail: 'Request submitted from the field' },
      { id: 'h-1041-2', at: at(-21, '09:12'), actor: 'Leena Patel', action: 'Approved' },
      { id: 'h-1041-3', at: at(-20, '08:02'), actor: 'Sara Brennan', action: 'PO generated', detail: historicalPo(7) },
      { id: 'h-1041-4', at: at(-20, '08:30'), actor: 'Sara Brennan', action: 'Marked ordered', detail: 'Simulated — no order was placed' },
      { id: 'h-1041-5', at: at(-14, '11:15'), actor: 'Mike Carter', action: 'Marked received' },
      { id: 'h-1041-6', at: at(-11, '15:05'), actor: 'Sara Brennan', action: 'Completed', detail: 'Packing slip matched, closed out' },
    ],
  },
  {
    id: 'PR-1046',
    status: 'Received',
    poNumber: historicalPo(5),
    requestorId: 'r-druiz',
    jobId: 'j-24132',
    vendorId: 'v-parkway',
    priority: 'Standard',
    neededBy: day(-6),
    estimatedCost: 18750,
    notes: 'Retrofit fixture package, phase 1. Confirm driver compatibility before install.',
    lines: [
      { id: 'l-1046-1', quantity: 120, unit: 'ea', description: '2x4 LED troffer, 4000K, 0-10V dim', stockNumber: 'LT24-40-D' },
      { id: 'l-1046-2', quantity: 12, unit: 'ea', description: 'Occupancy sensor, high-bay lens', stockNumber: 'OS-HB-2' },
    ],
    createdAt: at(-16, '13:22'),
    updatedAt: at(-6, '09:48'),
    history: [
      { id: 'h-1046-1', at: at(-16, '13:22'), actor: 'Danny Ruiz', action: 'Created' },
      { id: 'h-1046-2', at: at(-15, '08:55'), actor: 'Leena Patel', action: 'Approved', detail: 'Over threshold — PM sign-off' },
      { id: 'h-1046-3', at: at(-15, '10:10'), actor: 'Sara Brennan', action: 'PO generated', detail: historicalPo(5) },
      { id: 'h-1046-4', at: at(-15, '10:20'), actor: 'Sara Brennan', action: 'Marked ordered', detail: 'Simulated — no order was placed' },
      { id: 'h-1046-5', at: at(-6, '09:48'), actor: 'Danny Ruiz', action: 'Marked received', detail: 'Short 4 troffers, backordered' },
    ],
  },
  {
    id: 'PR-1052',
    status: 'Ordered',
    poNumber: historicalPo(3),
    requestorId: 'r-tnolan',
    jobId: 'j-24140',
    vendorId: 'v-metro',
    priority: 'High',
    neededBy: day(2),
    estimatedCost: 9640,
    notes: '400A service upgrade gear. Utility coordination scheduled for next week.',
    lines: [
      { id: 'l-1052-1', quantity: 1, unit: 'ea', description: '400A 208Y/120V main breaker panel', stockNumber: 'MBP-400-208' },
      { id: 'l-1052-2', quantity: 1, unit: 'ea', description: 'Meter socket, 400A, utility approved' },
      { id: 'l-1052-3', quantity: 60, unit: 'ft', description: '4/0 AL SER cable', stockNumber: 'SER-4/0' },
    ],
    createdAt: at(-8, '06:58'),
    updatedAt: at(-7, '11:31'),
    history: [
      { id: 'h-1052-1', at: at(-8, '06:58'), actor: 'Tom Nolan', action: 'Created' },
      { id: 'h-1052-2', at: at(-8, '07:45'), actor: 'Leena Patel', action: 'Approved' },
      { id: 'h-1052-3', at: at(-7, '11:20'), actor: 'Sara Brennan', action: 'PO generated', detail: historicalPo(3) },
      { id: 'h-1052-4', at: at(-7, '11:31'), actor: 'Sara Brennan', action: 'Marked ordered', detail: 'Simulated — no order was placed' },
    ],
  },
  {
    id: 'PR-1055',
    status: 'Ordered',
    poNumber: historicalPo(1),
    requestorId: 'r-sbrennan',
    jobId: 'j-24170',
    vendorId: 'v-tristate',
    priority: 'Standard',
    neededBy: day(1),
    estimatedCost: 1150,
    notes: 'Weekly lift rental for the warehouse crew.',
    lines: [
      { id: 'l-1055-1', quantity: 1, unit: 'wk', description: '26 ft scissor lift rental, delivered' },
      { id: 'l-1055-2', quantity: 1, unit: 'ea', description: 'Delivery and pickup charge' },
    ],
    createdAt: at(-4, '10:05'),
    updatedAt: at(-4, '14:40'),
    history: [
      { id: 'h-1055-1', at: at(-4, '10:05'), actor: 'Sara Brennan', action: 'Created' },
      { id: 'h-1055-2', at: at(-4, '13:02'), actor: 'Leena Patel', action: 'Approved' },
      { id: 'h-1055-3', at: at(-4, '14:20'), actor: 'Sara Brennan', action: 'PO generated', detail: historicalPo(1) },
      { id: 'h-1055-4', at: at(-4, '14:40'), actor: 'Sara Brennan', action: 'Marked ordered', detail: 'Simulated — no order was placed' },
    ],
  },
  {
    id: 'PR-1058',
    status: 'Approved',
    poNumber: null,
    requestorId: 'r-mcarter',
    jobId: 'j-24118',
    vendorId: 'v-hvsupply',
    priority: 'High',
    neededBy: day(3),
    estimatedCost: 3320,
    notes: 'Trim-out material. Approved, still needs a PO before it goes to the counter.',
    lines: [
      { id: 'l-1058-1', quantity: 85, unit: 'ea', description: 'Duplex receptacle, 20A, hospital grade', stockNumber: 'HG-5362' },
      { id: 'l-1058-2', quantity: 85, unit: 'ea', description: 'Stainless wall plate, single gang' },
      { id: 'l-1058-3', quantity: 14, unit: 'ea', description: '20A 1P breaker, bolt-on', stockNumber: 'BR120' },
    ],
    createdAt: at(-2, '07:12'),
    updatedAt: at(-2, '08:44'),
    history: [
      { id: 'h-1058-1', at: at(-2, '07:12'), actor: 'Mike Carter', action: 'Created' },
      { id: 'h-1058-2', at: at(-2, '08:44'), actor: 'Leena Patel', action: 'Approved' },
    ],
  },
  {
    id: 'PR-1061',
    status: 'Pending Approval',
    poNumber: null,
    requestorId: 'r-druiz',
    jobId: 'j-24151',
    vendorId: 'v-metro',
    priority: 'Emergency',
    neededBy: day(0),
    estimatedCost: 4275,
    notes: 'Generator tie-in parts. Town wants the garage back on standby power tonight.',
    lines: [
      { id: 'l-1061-1', quantity: 1, unit: 'ea', description: '200A automatic transfer switch', stockNumber: 'ATS-200' },
      { id: 'l-1061-2', quantity: 4, unit: 'ea', description: '2" rigid conduit, 10 ft length' },
      { id: 'l-1061-3', quantity: 1, unit: 'lot', description: 'Misc fittings and lugs' },
    ],
    createdAt: at(0, '06:30'),
    updatedAt: at(0, '06:30'),
    history: [
      { id: 'h-1061-1', at: at(0, '06:30'), actor: 'Danny Ruiz', action: 'Created', detail: 'Emergency priority — routed for approval' },
    ],
  },
  {
    id: 'PR-1062',
    status: 'Pending Approval',
    poNumber: null,
    requestorId: 'r-tnolan',
    jobId: 'j-24163',
    vendorId: 'v-harbor',
    priority: 'Standard',
    neededBy: day(5),
    estimatedCost: 6890,
    notes: 'Retail build-out branch circuit material.',
    lines: [
      { id: 'l-1062-1', quantity: 3000, unit: 'ft', description: '12/2 MC cable', stockNumber: 'MC122' },
      { id: 'l-1062-2', quantity: 200, unit: 'ea', description: 'MC connector, 3/8" snap-in' },
      { id: 'l-1062-3', quantity: 24, unit: 'ea', description: '4" octagon box with bracket' },
    ],
    createdAt: at(-1, '15:47'),
    updatedAt: at(-1, '15:47'),
    history: [
      { id: 'h-1062-1', at: at(-1, '15:47'), actor: 'Tom Nolan', action: 'Created' },
    ],
  },
  {
    id: 'PR-1063',
    status: 'Draft',
    poNumber: null,
    requestorId: 'r-lpatel',
    jobId: 'j-24132',
    vendorId: 'v-northline',
    priority: 'Low',
    neededBy: day(10),
    estimatedCost: 640,
    notes: 'Still confirming quantities with the field before this goes anywhere.',
    lines: [
      { id: 'l-1063-1', quantity: 10, unit: 'ea', description: '10 ft strut, 1-5/8", pre-galvanized', stockNumber: 'ST158-10' },
      { id: 'l-1063-2', quantity: 100, unit: 'ea', description: '3/8" wedge anchor' },
    ],
    createdAt: at(0, '08:15'),
    updatedAt: at(0, '08:15'),
    history: [
      { id: 'h-1063-1', at: at(0, '08:15'), actor: 'Leena Patel', action: 'Created', detail: 'Saved as draft' },
    ],
  },
  {
    id: 'PR-1049',
    status: 'Rejected',
    poNumber: null,
    requestorId: 'r-mcarter',
    jobId: 'j-24140',
    vendorId: 'v-parkway',
    priority: 'Standard',
    neededBy: day(-2),
    estimatedCost: 12400,
    notes: 'Decorative fixture package.',
    lines: [
      { id: 'l-1049-1', quantity: 32, unit: 'ea', description: 'Pendant fixture, brushed nickel' },
      { id: 'l-1049-2', quantity: 32, unit: 'ea', description: 'Canopy kit, sloped ceiling' },
    ],
    createdAt: at(-10, '09:03'),
    updatedAt: at(-9, '16:20'),
    history: [
      { id: 'h-1049-1', at: at(-10, '09:03'), actor: 'Mike Carter', action: 'Created' },
      {
        id: 'h-1049-2',
        at: at(-9, '16:20'),
        actor: 'Leena Patel',
        action: 'Rejected',
        detail: 'Fixtures are owner-furnished on this job — do not buy',
      },
    ],
  },
  {
    id: 'PR-1050',
    status: 'Canceled',
    poNumber: null,
    requestorId: 'r-sbrennan',
    jobId: 'j-24163',
    vendorId: 'v-harbor',
    priority: 'High',
    neededBy: day(-4),
    estimatedCost: 890,
    notes: 'Duplicate of PR-1062 — canceled by the office.',
    lines: [
      { id: 'l-1050-1', quantity: 500, unit: 'ft', description: '12/2 MC cable', stockNumber: 'MC122' },
    ],
    createdAt: at(-9, '11:11'),
    updatedAt: at(-9, '11:40'),
    history: [
      { id: 'h-1050-1', at: at(-9, '11:11'), actor: 'Sara Brennan', action: 'Created' },
      { id: 'h-1050-2', at: at(-9, '11:40'), actor: 'Sara Brennan', action: 'Canceled', detail: 'Duplicate request' },
    ],
  },
];

export function buildInitialState(): DemoState {
  return {
    version: STATE_VERSION,
    settings: {
      approvalMode: 'threshold',
      approvalThreshold: 1000,
      alwaysApproveEmergency: true,
      nextPoNumber: FIRST_DEMO_PO_NUMBER,
    },
    vendors: DEMO_VENDORS,
    jobs: DEMO_JOBS,
    requestors: DEMO_REQUESTORS,
    // Structured clone keeps the exported seed arrays immutable across resets.
    requests: structuredClone(DEMO_REQUESTS),
  };
}
