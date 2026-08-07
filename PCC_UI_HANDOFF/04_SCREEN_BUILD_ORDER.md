# PCC Screen Build Order

The implementation order is intentionally dependency-aware.

## Stage A — Foundation
A1. Reconcile design tokens with existing app
A2. Reusable component primitives
A3. Authenticated product shell

## Stage B — Core Daily Workflow
01. Login / Authentication
02. Dashboard
03. New Request
04. Purchasing Queue
05. Purchase Order Detail
06. Receiving

These six screens are the highest priority because together they form the usable end-to-end purchasing loop.

## Stage C — Knowledge / Administration
07. Vendors
08. Vendor Profile
09. Material Catalog
10. Administration

## Definition of “Screen Complete”
A screen is complete only when:
- route renders
- shared shell is correct
- required states/actions are represented
- existing backend/domain data is connected where available
- no obvious mobile/desktop breakage
- empty/loading/error states exist where relevant
- focused tests/build checks pass
