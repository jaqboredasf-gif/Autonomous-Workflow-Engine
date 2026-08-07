# PCC Component Library v1

This file defines the minimum reusable component system required before building Screens 01–10.

## 1. PCC Button
Properties:
- Type: Primary | Secondary | Ghost | Danger
- Size: M (40px) | L (48px)
- State: Default | Disabled
- Label: editable text

Rules:
- Primary: blue background, white label.
- Secondary: white surface, neutral border.
- Ghost: no container unless hovered/focused.
- Danger: red background, white label.
- Disabled: no interaction and visibly reduced emphasis.
- L size is preferred for field/mobile primary actions.

## 2. PCC Input
Types:
- Text
- Search
- Select
- Date
- Number
- Currency
- Textarea
- Vendor Search
- Material Search

States:
- Default
- Hover
- Focus
- Filled
- Error
- Disabled

Properties:
- Label
- Placeholder
- Value
- Helper text
- Error text
- Required
- Leading icon
- Trailing action

Rules:
- Label remains visible after data entry.
- Error state always includes text.
- Desktop height 40px; field/mobile target 48px.
- Vendor/Material selections preserve canonical entity IDs.
- Manual entry remains possible where explicitly allowed.

## 3. PCC Status Badge
Canonical states:
- Draft
- Requested
- Needs Approval
- Approved
- Email Drafted
- Ordered
- Partially Received
- Received
- Completed
- Backordered
- Cancelled
- Rejected

Semantic mapping:
- Neutral: Draft
- Info: Requested, Email Drafted, Ordered
- Warning: Needs Approval, Partially Received, Backordered
- Success: Approved, Received, Completed
- Danger: Cancelled, Rejected

## 4. Navigation
### Sidebar
Items:
- Dashboard
- Requests
- Purchasing
- Receiving
- Vendors
- Materials
- Reports
- Administration

States:
- Default
- Hover
- Active
- Disabled

### Topbar
Contains:
- Current page title
- Global search
- Notifications
- User menu
- Optional job/vendor contextual search

### Breadcrumb
Used on deep detail screens:
Dashboard / Purchasing / PO-1048

### Tabs
Used where one entity has multiple views:
Overview | Items | Activity | Documents

## 5. Data Table System
Variants:
- Standard
- Compact
- Grouped
- Selectable
- Expandable

Table features:
- Sticky header where useful
- Sortable headers
- Search/filter support
- Optional bulk selection
- Status badge cells
- Primary row action
- Overflow actions menu
- Empty state
- Loading state

Core PCC columns:
Request/PO, Job, Vendor, Requester, Priority, Status, Needed By, Age, Amount, Action

Rules:
- High-value operational data remains visible.
- Avoid forcing users to memorize item context.
- Ordered and drafted work remains visible until received/completed.

## 6. Cards
### KPI Card
Fields:
- Label
- Value
- Delta or secondary context
- Optional icon
- Optional link

### Purchase Card
Fields:
- Request/PO #
- Job
- Requester
- Vendor
- Status
- Item count
- Needed-by date
- Primary action

### Vendor Card
Fields:
- Vendor
- Categories
- Preferred flag
- Contact
- Lead time
- Reliability
- Last order

### Material Card
Fields:
- Canonical material
- Category
- Preferred vendor
- Last price
- Common quantity
- Aliases

## 7. Timeline
Step types:
- Created
- Submitted
- Approved
- PO Generated
- Vendor Email Drafted
- Ordered
- Partially Received
- Received
- Completed
- Cancelled

Each event:
- actor
- action
- timestamp
- optional note
- optional linked document

## 8. Activity Feed
Examples:
- Mike approved PO-1048
- Rick marked PO-1041 ordered
- Foreman confirmed partial receipt
- Vendor email draft created
- Office received receipt

## 9. Filters
Components:
- Search field
- Status filter
- Job filter
- Vendor filter
- Requester filter
- Priority filter
- Date range
- Clear filters
- Saved view (future-ready)

## 10. Receiving Components
### Receiving Item
Fields:
- Item
- Ordered qty
- Previously received
- Receiving now
- Remaining
- Condition

### Receipt Confirmation
Options:
- Everything received
- Partial receipt
- Damaged
- Incorrect item
- Missing item

### Evidence Upload
- Photo
- Delivery slip
- Receipt
- Note

Rules:
- Mobile first.
- Foreman can verify only authorized destination/job receipts.
- Partial receipt does not close PO.
- Receipt confirmation produces audit event.

## 11. Feedback Components
- Success toast
- Warning alert
- Error alert
- Confirmation modal
- Destructive confirmation modal
- Empty state
- Skeleton card
- Skeleton table
- Inline validation
- Unsaved changes warning

## 12. Higher-Level Compositions
These are composed from primitives and should not become independent visual languages:
- Dashboard KPI row
- Purchasing Queue toolbar
- Purchasing Queue grouped table
- PO summary header
- Approval panel
- Vendor intelligence summary
- Material autocomplete dropdown
- Receiving confirmation panel
