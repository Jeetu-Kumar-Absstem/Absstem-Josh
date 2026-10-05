# ERP system guide

This document is based on the live left navigation and the pages currently visible in the ERP. The descriptions below come from the page titles, form fields, tables, and buttons available after login, so this is a practical system map rather than a technical source-code design.

## What the system looks like overall

This ERP appears to combine several business functions in one system:

- lead capture and sales follow-up
- quotation and sales order management
- invoice generation and dispatch
- CRM and service/site visit handling
- item, customer, vendor, and pricing masters
- purchase, store, QC, GRN, and stock control
- production/job tracking
- accounting and posting
- employee, payroll, leave, recruitment, grievance, and asset management
- internal PMS/task tracking

In business terms, the system looks like it works in this broad sequence:

1. A lead is created and followed up.
2. A quotation is generated and approved.
3. The quotation is converted into a sales order.
4. The sales order moves to invoice, dispatch, and in some cases service or production.
5. Purchase and store modules support material procurement, QC, receipt, stock, and issue.
6. Dispatch and production modules handle physical execution and shipment.
7. Account posting modules convert operational transactions into accounting entries.
8. HR/payroll modules manage employees, salary, leave, recruitment, and internal documents.

## Cross-module workflow

### Sales flow

The front-office workflow is clearly visible:

- `Lead Entry` captures prospects, contacts, addresses, and follow-up details.
- `Generate Quotation` builds a commercial offer with items, terms, follow-up, and mailing actions.
- `Generate Sales Order` converts quotations into order documents with consignee and dispatch details.
- `Generate PI` and `Generate Invoice` create commercial billing documents from sales data.
- `Dispatch Invoice` and the `Dispatch` module move approved invoiced material into shipping execution.

This suggests the sales cycle is tightly connected from lead to invoice rather than being separate systems.

### Service flow

The service side seems to support both complaint handling and planned site activity:

- `Complaint Entry` creates service tickets tied to customer/invoice/serial data.
- `Complaint Assignment` assigns engineers.
- `Service Entry` updates service status and remarks.
- `Site Visit` raises visit requests.
- `Engineer Assignment`, `Update Visit Request`, and `Site Visit Feedback` handle field execution.

This looks like a post-sales support workflow linked to installed machines and service engineers.

### Purchase and store flow

The purchase section shows a clear procurement-to-stock process:

1. `Purchase Indent Form ( F/STR/04)` raises the material requirement.
2. `Receive Quote` and `Compare Quote Report` collect vendor responses.
3. `Approval Of Quote` authorizes the selected vendor quote.
4. `Generate PO` creates the purchase order.
5. `Tracking And Courier`, `Item Receive`, `GRN`, and `QC` record receipt and quality control.
6. `Handover To Store`, `Stock Ledger View`, `Stock Report`, `MR Wise Issue`, and `Item Returns` manage inventory movement after receipt.

This module looks much more like an operational store/purchase ERP than just a vendor register.

### Production flow

The production area suggests a manufacturing execution workflow around jobs:

- `Pending For Job Entry` and `Pending For Approval` look like job creation gates.
- `Pending For Sub Assembly`, `Pending For Mounting Plate`, `Pending For Skid Assembly`, and `Pending For Plant Assembly` show stage-wise production tracking.
- `Factory Test Status Entry`, `QC Report Entry`, `QC Approval`, and `Handover To Packing` show test, quality, and packing checkpoints.
- `Job No Tracker` and multiple reports provide status visibility.

This looks like job-based production tracking for equipment or plant assemblies.

### Accounts flow

The accounts module appears to be a posting and voucher layer over operational transactions:

- master accounting setup through `Account Master` and `Account Mapping`
- manual voucher entry with `Journal Voucher`, `Receipt Voucher`, and `Payment Voucher`
- automated postings for customer, vendor, employee, salary, expense, invoice, and credit/debit transactions
- reporting through `Ledger View` and `Client OutStanding`

The design suggests operations happen first in sales, expense, payroll, or purchase pages, then accounting postings are executed here.

## Section-by-section map

## Dashboard

This section is the high-level monitoring area.

- `Dashboard`: main summary dashboard.
- `Lead Dashboard`: sales pipeline and lead activity view.
- `Complaint Dashboard`: service complaint activity summary.
- `Expense Dashboard`: expense monitoring dashboard.
- `Account Dashboard`: finance dashboard with date, department, employee, and verification filters.
- `AttendanceDashboard`: attendance and leave summary.
- `Site Visit Dashboard`: field service or site-visit performance summary.

## Lead

This section manages pre-sales opportunity capture and ownership.

- `Lead Entry`: create and update leads with company, contact, address, category, item details, and follow-up details.
- `Lead Entry Report`: search leads by date, prospect, geography, category, group, and contact.
- `Pending Follow Up`: list of leads waiting for follow-up.
- `Re-Assign Lead`: transfer a lead to a new lead manager with reason.
- `Re-Assign(Marketing Manager)`: marketing-manager-level lead reassignment.

## Quotation

This section turns leads into formal commercial offers.

- `Generate Quotation`: create quotations with customer details, item details, supply package, terms and conditions, and send/save actions.
- `Pending For Follow Up`: quotations awaiting follow-up.
- `Merge Duplicate Customer`: merge duplicate customer records.
- `Pending for Approval`: quotations waiting for approval.
- `Quotation Report`: search quotations by date, customer, city, salesperson, status, lead, and company.
- `Re-Assign Quotation`: reassign quotation ownership.
- `Re-Assign(Marketing Manager)`: marketing-level quotation reassignment.

## Sale Order

This section converts approved quotations into executable customer orders.

- `Pending For Sales Order`: quotations or cases waiting to be converted into sales orders.
- `Generate Sales Order`: create sales orders with consignee details, dispatch details, item details, supply package, and terms.
- `Pending For Approval`: sales orders waiting for approval.
- `Sales Order Report`: filterable reporting by date, group, customer, order number, salesperson, status, city, job number, and company.

## Invoice

This section manages customer billing documents.

- `Pending For Invoice`: sales orders or cases waiting to become invoices.
- `Generate PI`: create proforma invoices.
- `Generate Invoice`: create final invoices with store, principal, invoice type, pricing, and item details.
- `Pending Customer Invoice`: customer-side invoices still pending.
- `Invoice Amendment`: update or amend an issued invoice.
- `Invoice Pending For Approval`: invoices waiting for approval.
- `Invoice Report`: invoice search/report by date, type, number, customer, salesperson, city, and status.
- `Proforma Invoice Report`: reporting for PI documents.
- `Dispatch Invoice`: mark invoices for dispatch execution.

## CRM

This section handles complaint-based after-sales support.

- `Complaint Entry`: log a complaint against customer, invoice, and serial information.
- `Complaint Assignment`: assign a complaint to a service engineer with remarks.
- `Service Entry`: record service status updates and remarks.
- `Complaint Report`: report of complaints by date, customer, engineer, serial number, and status.
- `Service Tracker`: quick search by serial number or complaint number.

## Import

This section supports bulk master/data uploads.

- `Item Master Import`: upload and merge item master data, download format, and export exceptions.
- `Import LeadEntry`: bulk upload lead entries.

## General Setting

This section appears to store company-wide defaults.

- `Default Settings`: company name, address, email defaults, postal/contact info, and legal identifiers.

## Master

This is the central setup area for core business entities and reference data.

- `Customer Master`: customer profile, contact, location, and communication setup.
- `Principal Master`: principal/company setup with contact and bank details.
- `Group Master`: product or item grouping with category, description, image, and serial requirements.
- `Item Master`: item definitions with category, group, item type, UOM, HSN, price, and GST.
- `Price Type Master`: price types and percentage logic.
- `Term & Condition Master`: reusable terms for quotation, sales order, invoice, and PO.
- `Sale/Invoice Charges`: charge captions and whether they apply in sale order, invoice, or stock entry.
- `Currency Master`: currency codes and names.
- `Country Master`: country setup.
- `State Master`: state setup with GST state code.
- `City Master`: city setup by country and state.
- `Category Master`: category naming, prefixes, start number, and job-number options.
- `Reason Master`: reasons used in quotation/lead processes.
- `Prospect Master`: prospect company master similar to customer registration.
- `Status Master`: shared statuses for quotation, lead, and job.
- `Lead Source`: lead source configuration including SEO tagging.
- `Supply Package`: reusable supply-package descriptions and units.
- `Expense Master`: expense types and document mandatory flag.
- `Expense Capping`: department-wise expense limits.
- `Courier Master`: courier codes and tracking URL patterns.
- `Vendor Master`: vendor registration with payment, receiving, and document upload sections.
- `BOM`: bill of materials with sub-item quantities.
- `Zone Master`: zone definitions.
- `Company Master`: company/legal entity master with banking data.
- `UOM Master`: units of measure.
- `Store Master`: store or warehouse definitions.
- `User Company Access`: map users to allowed companies.
- `Update List Price`: bulk or manual list-price update utility.
- `Purpose Master`: purpose-of-visit or purpose reference setup.
- `Update Item Stock`: stock correction or stock update utility.
- `Visit Type Master`: visit-type definitions linked to complaints.
- `Recommendation Master`: recommendation setup by category type.
- `Engineer Master`: engineer type/name setup.
- `Factory Test Master`: reusable factory test parameters and values.
- `Currency Exchange Rate`: effective-date exchange-rate setup.
- `Add Library Master`: library links/resources with user-group permission.

Most `Master` screens follow a common pattern: create, update, export, reset, and search.

## User

This section manages access, permissions, and login administration.

- `User Master`: create user records, assign group/company/employee/reporting heads.
- `User Group Master`: define access groups.
- `Group Menu Access`: assign menu permissions by group.
- `User Menu Access`: assign direct permissions by user.
- `Change Password`: self-service password change.
- `Reset Password`: admin password reset.
- `User Log Report`: audit/search user log activity.
- `Pending For Approval User`: pending user approvals.
- `Update Dis Reporting Head`: change distributor reporting heads.

## Expense

This section manages employee or operational vouchers plus approval workflow.

- `Expense/Advance Voucher`: create expense or advance vouchers with department, company, customer, and supporting details.
- `Expense Approval`: verify, recheck, reject, or save expense approvals.
- `Expense Recheck`: track items sent for recheck.
- `Expense Report`: expense reporting by user, company, department, customer, and status.
- `Advance Approval`: approval workflow for advances.
- `Advance Recheck`: recheck queue for advances.
- `Advance Report`: reporting for advances.
- `Voucher Ledger`: ledger-style reporting of expense/advance vouchers.

## Dispatch

This section handles shipment preparation, approval, challan, and dispatch execution.

- `Pending For Dispatch`: queue of dispatch-ready items.
- `Pending Dispatch Approval`: approval list before shipment.
- `Dispatch Request Packing`: packing workflow with item details and packed-plant image attachments.
- `Rate Update`: update courier/mode/cost details.
- `Rate Approval`: approve shipping rate and remarks.
- `Delivery Challan`: create challan with vehicle, station, transport, and docket data.
- `Dispatch Entry`: record final dispatch with invoice, e-way bill, docket, and attachment.
- `Dispatch Request Report`: reporting for dispatch requests.
- `Delivery Challan Report`: challan reporting.
- `Dispatch Report`: final shipment report.

## Purchase

This section is a complete procurement and store-control workflow.

- `Purchase Indent Form ( F/STR/04)`: raise a material indent/MIF with item, quantity, due date, department, MR, and job number.
- `MIF Report`: report for raised indents.
- `Receive Quote`: capture vendor quotations against MIFs.
- `Compare Quote Report`: compare vendor quotes.
- `Approval Of Quote`: approve or reject vendor quote selection.
- `Pending For PO`: approved items waiting for purchase order.
- `Generate PO`: issue a PO with vendor, communication, delivery, items, and terms.
- `PO Report`: PO reporting.
- `Tracking And Courier`: track PO shipment/courier details.
- `Tracking Courier Report`: report for courier and tracking status.
- `Item Receive`: receive material against POs.
- `Item Receive Report`: received-item reporting.
- `GRN`: goods receipt note with invoice details and attachments.
- `QC`: perform quality checking for received goods.
- `QC Report`: QC reporting.
- `Upload TC`: attach or manage test certificates.
- `Stock Ledger View ( F/STR/02)`: stock movement ledger.
- `Material Requisition (F/STR/03)`: internal issue request from stores, including import utility.
- `Material Requisition Report`: report of requisitions.
- `Department Head Approval`: approval step for requisitions.
- `Item Issue Report`: issued-item report by department, serial, MR, and job.
- `Stock Report`: current or filtered stock reporting.
- `GRN Report`: GRN reporting.
- `PR Report`: purchase reconciliation report.
- `MR Pending For Issue`: approved requisitions still waiting for issue.
- `MR Wise Issue`: issue material against a requisition and print the issue.
- `QC Recheck`: QC recheck workflow.
- `Item Returns`: return materials back to store.
- `Item Returns Report`: return reporting.
- `Handover To Store`: move QC-cleared items into store.
- `Gate Item Receive`: gate-level material receipt entry.
- `Material Receipt Register (F/STR/01)`: receipt register report.
- `Gate Item Receive Report`: reporting of gate entries.

## Service

This section appears to support commissioning and site engineering work beyond complaint logging.

- `Pending For Commissioning`: pending commissioning jobs.
- `Pending For Site Visit`: pending site-visit requests.
- `Commissioning Report`: report of commissioning by date, serial, customer, engineer, and status.
- `Site Visit`: create a site visit/service request with dispatch, warranty, engineer, address, and item details.
- `Site For Approval`: site requests waiting for approval.
- `Engineer Assignment`: assign engineers to visit tasks.
- `Update Visit Status`: update open visit status.
- `Update Visit Request`: engineer-side request update with site, installation, equipment, included items, and parameters.
- `Service No Query`: quick query by serial, job, or request number.
- `Site Visit Feedback`: save visit feedback and upload supporting files.
- `Site Visit Report`: report of site visits.
- `Site Feedback Report`: report of post-visit feedback.

## Payroll Master

This section defines payroll configuration and policy objects.

- `Department Master`: departments.
- `Designation Master`: designations.
- `Allowance Master`: allowance setup, display names, sequence, and payroll behavior.
- `Deduction Master`: deduction setup.
- `Leave Master`: leave rules, abbreviations, limits, carry-forward, and application type.
- `Holiday Master`: state/date holiday calendar.
- `Template Master`: format/template mapping by designation.
- `Reating Criteria Master`: performance rating criteria.
- `Extra Allowance Master`: extra allowance configuration.

## Employee

This section supports HR operations and salary processing.

- `Employee Master`: full employee registration with personal details, addresses, document upload, and profile picture.
- `Employee Verify HOD`: HOD verification of employees.
- `Search Employee`: employee search/report screen.
- `Import Employee`: bulk employee import.
- `Import Attendance`: bulk attendance import.
- `Import Salary Structure`: bulk salary-structure import.
- `Process Salary`: salary processing by company, employee, month, and year.
- `Update Employee`: bulk update utility.
- `Attendance Verification`: verify attendance ranges.
- `Verify Bank Details`: verify employee banking information.
- `Verify Document`: verify employee documents.
- `Employee Rejoining`: re-activate or rejoin former employees.
- `Verify Salary`: verify generated salaries.
- `Un Verify Salary`: reverse salary verification.
- `Import Salary Disbursment`: bulk import salary payment/disbursement status.
- `Import Extra Allowance/Ddeduction`: bulk import extra payroll adjustments.
- `Import Opening Leave`: initialize leave balances.

## PayrollReport

This section is the reporting/output layer for payroll and attendance.

- `Salary Sheet In Excel`: export salary sheets.
- `Payslip`: print employee payslips.
- `Mobile Attendance Report`: attendance based on mobile data.
- `Attendance Report`: monthly attendance reporting.
- `Salary Disbursment Report`: report of salary payment/disbursement.
- `Leave Status Report`: leave status reporting.
- `Leave Register Report`: leave register summary.

## Leave Management

This section handles leave transactions.

- `Leave Application`: employee leave request entry.
- `Leave Approval`: approve/reject applications and view leave registers.
- `Leave Status`: quick leave-status lookup.

## Print

This section prints standard HR letters.

- `Appointment Letter`: generate appointment letter.
- `Relieving Letter`: generate relieving letter.
- `Exprience Letter`: generate experience letter.
- `Salary Increment Letter`: generate salary increment letter.
- `Confirmation Letter`: generate confirmation letter.
- `Offer Letter`: generate offer letter.
- `Warning Letter`: generate warning letter.
- `Promotion Letter`: generate promotion letter.

Most of these pages include `Preview`, `Print`, and `History`.

## Job

This section is the recruitment workflow.

- `Job Requisition`: raise a vacancy request.
- `Approve Job Requisition`: approve or reject requisitions.
- `Job Posting`: publish the job and define interviewers/checklists.
- `ShortList Candidate`: shortlist or reject candidates.
- `Schedule Interview`: schedule interviews.
- `Interview Report`: interview status reporting.
- `Manage Interview`: update interview and candidate status.
- `Finalize Candidate`: finalize a candidate and capture profile/documents.
- `Candidate Offer Letter`: generate and send candidate offer letters.
- `Acceptance OfferLetter`: record acceptance.
- `Verify Candidate`: candidate verification.
- `Convert To Employee`: convert accepted candidates into employee records.
- `Search Candidate`: candidate search/report.

## Grievance

This section seems to be an internal support/ticketing system.

- `TS Category Master`: grievance category setup.
- `Sub Category Master`: subcategory, TAT, and escalation setup.
- `Grievance`: create grievance/ticket entries with channel, source, employee, category, and status.
- `Ticket Report`: report and assignment visibility for tickets.

## Account

This section is the finance posting and voucher engine.

- `Account Master`: chart-of-account style master setup.
- `Journal Voucher`: general journal entries with CR/DR lines.
- `Receipt Voucher`: receipt entries.
- `Ledger View`: ledger reporting.
- `Client OutStanding`: receivable/payable-style outstanding report.
- `Vendor Posting`: post vendor transactions.
- `Customer Posting`: post customer transactions.
- `Employee Posting`: post employee-related transactions.
- `Account Mapping`: map operational flows to GL accounts.
- `Employee Expense Account Posting`: post expense claims to accounts.
- `Sale Invoice Account Posting`: post invoice accounting entries.
- `Credit Debit Entry`: create credit/debit notes.
- `Credit Debit Posting`: post credit/debit notes.
- `Salary Payable Posting`: salary liability posting.
- `Expense Payable Posting`: expense payable posting.
- `ExpensePaidPosting`: expense payment posting.
- `Employee Salary Paid Posting`: salary payment posting.
- `UN Posting`: unpost or reverse posted items.
- `Payment Voucher`: payment entries.
- `Advanced Paid Posting`: advance-payment posting.

## Assets

This section controls internal asset requisition and issue.

- `Brand Master`: brand setup.
- `Assets Requisition`: raise an asset request.
- `Assets Requisition Approvel`: approve or reject asset requests.
- `Return Assets`: asset return or replacement.
- `Assets Report`: asset reporting.
- `AR Pending For Issue`: approved asset requests waiting to be issued.
- `AR Wise Issue`: issue assets against requests and print the issue.
- `AR Issue Report`: reporting for asset issue.

## PMS

This appears to be performance management.

- `Employee Performance Entry`: enter performance data and remarks.
- `Verify Employee Performance`: verify or unverify performance entries.

## Loan Management

This section manages employee loans.

- `Loan Type Master`: loan categories and limits.
- `Loan Master`: employee loan creation.
- `EMI Suspension`: suspend installments.
- `Loan Repay`: record repayment or write-off.
- `Import Loan`: currently appears broken in the live system. The page returns a server error saying the `ImportLoan` view was not found.

## Report

This is a small reporting section for system-level or utility reports.

- `Mail Log Report`: report of mail sending status by type and company.
- `Add Library Master Report`: report of library items by user group and library code.

## SEO

This section appears to connect marketing-source analysis with lead generation.

- `SEO Lead Report`: lead report with SEO-style filtering by date and geography.
- `SEO Analytics`: analytics by date range and lead manager.

## Production

This is the manufacturing execution area and looks very process-driven.

- `Pending For Job Entry`: starting queue for production jobs.
- `Pending For Approval`: job approval queue.
- `Pending For Sub Assembly`: sub-assembly queue.
- `Pending For Mounting Plate`: mounting-plate queue.
- `Pending For Checklist Mounting Plate`: checklist stage for mounting plates.
- `Pending For Skid Assembly`: skid assembly queue.
- `Pending For Plant Assembly`: plant assembly queue.
- `Update Job Status`: update production status.
- `Factory Test Status Entry`: record factory test status.
- `Pending For Test Approval`: approval queue for testing.
- `Factory Test Report`: report of tests by job and staff.
- `QC Report Entry`: QC entry with parameters, attachments, and final plant images.
- `QC Report`: QC reporting.
- `Handover To Packing`: move finished material to packing with carton-box details and packed-plant images.
- `Handover Approval`: approve handover and update vendor/status remarks.
- `Handover To Packing Report`: report for packing handovers.
- `QC Approval`: QC approval workflow with parameter lists and item details.
- `Job Status Report`: status reporting by job and dates.
- `Job No Tracker`: direct job tracker.
- `IDS Job Report`: IDS-specific job reporting.
- `Sub Assembly Report`: report for sub-assembly stage.
- `Mounting Plate Report`: mounting-plate reporting.
- `Checklist Mounting Plate Report`: checklist reporting for mounting plates.
- `Skid Assy Report`: skid assembly reporting.
- `Plant Assembly Report`: plant assembly reporting.

## Master PMS

This appears to be project/task-management setup.

- `Project Master`: define projects with customer and date range.
- `Category Master`: define task categories and TAT days.

## Operation PMS

This is the task execution area.

- `Task Management`: create tasks with project, category, department, module, priority, dates, assignee, and effort.
- `Task Execution Updates`: update progress or execution status of tasks.

## Report PMS

This is the reporting layer for the PMS area.

- `Task Report`: report by task, category, project, department, priority, employee, and status.
- `TAT Report`: turnaround-time reporting.

## How the ERP works in practice

From the screen structure, the ERP is probably meant to be used by several departments in the same database:

- sales/marketing use `Lead`, `Quotation`, `Sale Order`, and `Invoice`
- service engineers and support teams use `CRM` and `Service`
- purchase/store teams use `Purchase`
- dispatch teams use `Dispatch`
- production teams use `Production`
- finance uses `Expense` and `Account`
- HR/admin uses `Employee`, `Payroll`, `Leave`, `Print`, `Job`, `Assets`, `Loan Management`, and `Grievance`
- managers use dashboards, reports, approvals, and reassignment screens

The system also follows a common pattern on many pages:

- entry screen for creating a transaction
- pending/approval screen for authorization
- report screen for search/export
- master screen for maintaining reference data

That pattern is consistent across sales, expense, dispatch, purchase, service, production, and HR.

## Observations

- The ERP is broad and appears to cover CRM, ERP, HRMS, PMS, and service operations in one application.
- Most modules are form-driven and approval-based.
- Reporting and export options are present almost everywhere.
- Many pages support file upload/import and exception export, which suggests bulk operations are common.
- There is at least one visible broken page: `Loan Management -> Import Loan`.

