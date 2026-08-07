# PCC UI Acceptance Checklist

## Global
- [ ] Existing working PCC functionality preserved
- [ ] No new build/type/lint failures
- [ ] Shared design system used consistently
- [ ] Status text never depends on color alone
- [ ] Destructive actions confirmed
- [ ] Unauthorized actions hidden or disabled appropriately
- [ ] Responsive layout does not clip critical content

## Authentication
- [ ] Approved company-user flow exists
- [ ] Unauthorized user state exists
- [ ] Authentication is not used as the only authorization layer

## Dashboard
- [ ] Pending Approval visible
- [ ] Waiting to Order visible
- [ ] Ordered visible
- [ ] Awaiting Receipt visible
- [ ] Queue preview exists
- [ ] Recent activity exists

## Request
- [ ] Job
- [ ] Needed By
- [ ] Priority
- [ ] Item rows
- [ ] Quantity/unit
- [ ] Optional preferred vendor
- [ ] Notes
- [ ] Attachments shell
- [ ] Draft + Submit
- [ ] Material autocomplete contract supported

## Queue
- [ ] Search and filtering
- [ ] Requested
- [ ] Needs Approval
- [ ] Approved
- [ ] Email Drafted
- [ ] Ordered
- [ ] Partially Received
- [ ] Drafted/ordered work remains visible
- [ ] Next action visible

## PO Detail
- [ ] Job/vendor/requester/approver/status context
- [ ] Item table
- [ ] Timeline/activity
- [ ] Receiving progress
- [ ] Vendor Email available from PO
- [ ] Authority-sensitive actions

## Receiving
- [ ] Mobile-first
- [ ] Ordered / previously received / receiving now / remaining
- [ ] Partial receipt
- [ ] Missing/damaged/incorrect state
- [ ] Evidence upload shell
- [ ] Confirmation
- [ ] Does not mark fully Received prematurely

## Vendors
- [ ] Search/filter
- [ ] Operational vendor fields
- [ ] Link to vendor profile

## Vendor Profile
- [ ] Contact
- [ ] categories
- [ ] lead time
- [ ] operational notes
- [ ] history
- [ ] common materials
- [ ] reliability placeholder/metric if data exists

## Material Catalog
- [ ] canonical name
- [ ] alias search
- [ ] category
- [ ] preferred vendor
- [ ] last price/history where data exists
- [ ] active/inactive

## Administration
- [ ] users
- [ ] roles
- [ ] permissions
- [ ] jobs
- [ ] vendors
- [ ] materials
- [ ] audit
- [ ] no routine hard-delete of submitted purchasing records
