# PCC Product Screens 01–10 v1

## Screen 01 — Login / Authentication
Primary user: any authorized company employee.

Purpose:
Securely authenticate company users and route them to their role-appropriate workspace.

Layout:
- Centered PCC/Lippolis identity
- Company email field
- Password or approved auth method
- Sign In
- Forgot Password
- English / Español
- Help text for unauthorized users

Rules:
- Organization-controlled access.
- Only approved company accounts may enter.
- Invitation/allowlist status is checked in addition to email domain.
- Authentication does not equal authorization; role controls capabilities after login.

States:
Default, invalid credentials, unauthorized email, expired invitation, loading.

## Screen 02 — Dashboard
Primary user: Purchasing / management.

Purpose:
Understand purchasing workload in seconds.

Sections:
- Sidebar
- Topbar/global search
- KPI cards: Pending Approval, Waiting to Order, Ordered, Awaiting Receipt
- Operational purchasing queue preview
- Recent activity
- Alerts/exceptions

Primary actions:
New Request, Open Queue, Open Receiving, search PO/job/vendor.

## Screen 03 — New Request
Primary user: Requester / Foreman.

Fields:
- Job
- Needed By
- Priority
- Item rows
- Quantity
- Unit
- Preferred Vendor (optional)
- Notes
- Attachments

Material behavior:
- autocomplete canonical catalog
- alias matching
- recent/frequent materials first
- manual entry allowed if material absent

Actions:
Save Draft, Submit Request.

## Screen 04 — Purchasing Queue
Primary user: Purchasing.

Purpose:
Run daily purchasing operations without work disappearing between stages.

Controls:
Search, Status, Job, Vendor, Requester, Priority, Date, Clear Filters.

Grouped states:
Requested
Needs Approval
Approved
Email Drafted
Ordered
Partially Received

Each row/card:
- Request/PO
- Job
- Vendor
- Requester
- status
- age
- item count
- estimated amount where useful
- next action

Rule:
Items remain operationally visible until fully received/completed.

## Screen 05 — Purchase Order Detail
Primary user: Purchasing / office; limited view for requester/foreman.

Header:
- PO #
- Job
- Vendor
- Status
- Requested by
- Approved by
- Needed by
- Estimated/actual totals where permitted

Sections:
- Item table
- Vendor contact
- Documents
- Timeline/activity
- Receiving progress

Actions by authority:
Edit, Approve, Generate PO, Vendor Email, Mark Ordered, Record Receipt, Cancel.

Critical:
Vendor Email action is available from this screen without navigating back to request.

## Screen 06 — Receiving
Primary user: assigned foreman or authorized purchasing staff.

Mobile-first flow:
- PO + Job identity
- Delivery summary
- Each line item with ordered/received/remaining
- Receiving quantity
- condition/status
- Missing/damaged/incorrect controls
- Photo/document upload
- Notes
- Confirm Receipt

Rules:
- Supports partial delivery.
- PO reaches Received only when all required items are accounted for.
- User authority checked against job/destination.
- Confirmation writes audit event and receipt record.

## Screen 07 — Vendors
Primary user: Purchasing / office.

Purpose:
Find vendors and operational knowledge quickly.

Controls:
Search, category, preferred, delivery/pickup, lead-time filters.

List columns/cards:
Vendor, Category, Preferred, Contact, Typical Lead Time, Reliability, Last Order.

Action:
Open Vendor Profile.

## Screen 08 — Vendor Profile
Primary user: Purchasing / office.

Sections:
- identity/contact
- preferred categories
- emergency ordering availability
- delivery/pickup capabilities
- operational notes
- historical orders
- commonly purchased materials
- lead-time history
- price history where available
- reliability metrics

Future decision-support area:
recommended vendor/material fit based on history.

## Screen 09 — Material Catalog
Primary user: Purchasing / requesters.

Controls:
Search canonical name or alias, category, vendor.

Fields:
- Canonical name
- Category/subcategory
- Size
- Unit
- Manufacturer/part number
- Aliases
- Preferred vendor
- Last price
- Typical quantity
- Purchase frequency
- Active/inactive

Actions:
Open material, add/edit material where authorized.

## Screen 10 — Administration
Primary user: Administrator.

Modules:
- Users
- Roles
- Permissions
- Jobs
- Vendors
- Materials
- Notifications
- Audit Log
- Organization Settings

Rules:
- High-risk changes are explicit.
- Permission changes are audited.
- Submitted purchasing records are cancelled/archived rather than hard-deleted through normal UI.
