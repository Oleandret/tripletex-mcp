# PRD: Tripletex MCP Server — Full Rebuild

**Version:** 1.1
**Date:** 2026-04-08
**Author:** CWV Ventures AS
**Status:** Ready for implementation (PRD completed: DTO tables, endpoint map, env/auth, migration notes)

---

## 1. Problem Statement

The current Tripletex MCP server has critical field-mapping bugs that make it unusable for core operations like invoice creation. Specifically:

- The MCP sends `unitPriceExclVat` to the Tripletex API, but the API expects `unitPriceExcludingVatCurrency` (or `unitPriceIncludingVatCurrency`). This causes a `422` validation error: `"Feltet eksisterer ikke i objektet."`.
- The MCP tool schema marks `unitPriceExclVat` as required, blocking callers from omitting the price field entirely (which Tripletex supports when using products).
- There is no support for the `isPrioritizeAmountsIncludingVat` flag on the Order object, meaning the MCP cannot correctly handle accounts configured for prices including VAT.
- Overall, the MCP exposes a simplified/incorrect abstraction that doesn't match the actual Tripletex v2 API DTOs.

**Goal:** Rebuild the Tripletex MCP to be a thin, accurate, and flexible proxy over the Tripletex v2 REST API — using correct field names, supporting all relevant endpoints, and letting the LLM decide which fields to use based on context.

---

## 2. Design Principles

1. **Field names must match the Tripletex API exactly.** No aliases, no abbreviations. If Tripletex calls it `unitPriceExcludingVatCurrency`, the MCP tool parameter is `unitPriceExcludingVatCurrency`.
2. **Minimal required fields.** Only mark parameters as required if the Tripletex API actually requires them. Let the LLM and Tripletex defaults handle the rest.
3. **The MCP is a proxy, not a wizard.** It should expose Tripletex capabilities faithfully. Business logic (e.g., choosing VAT type, calculating prices) stays with the LLM caller.
4. **Comprehensive endpoint coverage.** The MCP should cover the full invoicing lifecycle plus commonly used supporting endpoints.
5. **Excellent error pass-through.** Tripletex validation errors should be returned verbatim to the caller so the LLM can self-correct.

**Tool parameter naming (reconciles principle 1 with §4 and §5.1):** Parameters that map to a nested Tripletex reference `{ field: { id: number } }` are exposed in tools as a flattened `fieldId` (e.g. `customerId`, `vatTypeId`, `currencyId`). The server expands these to `{ field: { id: value } }` per §5.1. Every other tool argument uses the same **leaf** names as the Tripletex JSON body (`count`, `unitPriceExcludingVatCurrency`, `orderDate`, `ourReference`, …). Nested objects the API accepts as a single value (e.g. `postalAddress`) are passed through as objects, unchanged.

---

## 3. Tripletex API Reference (Source of Truth)

**Base URL:** `https://tripletex.no/v2`
**Auth:** HTTP Basic with session token (employee token → session token exchange via `/token/session`)
**Docs:** https://tripletex.no/v2-docs/ (Swagger/OpenAPI)
**Developer portal:** https://developer.tripletex.no

### 3.1 Key DTO Field Names (CRITICAL)

These are the **exact** field names the Tripletex v2 API expects. The MCP must use these verbatim.

#### OrderLine DTO (for POST /order and POST /invoice)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `description` | string | No | Free-text line description |
| `count` | number | No | Quantity (Tripletex uses `count`, NOT `quantity`) |
| `unitPriceExcludingVatCurrency` | number | No* | Unit price excl. VAT in order currency |
| `unitPriceIncludingVatCurrency` | number | No* | Unit price incl. VAT in order currency |
| `vatType` | object `{ id: number }` | No | VAT type reference. Use `{ id: X }` to reference existing VAT type |
| `product` | object `{ id: number }` | No | Product reference. If set, price/account comes from product |
| `order` | object `{ id: number }` | No | Required when creating order lines via `/order/orderline` endpoint |
| `discount` | number | No | Discount percentage (0-100) |
| `amountExcludingVatCurrency` | number | Read-only | Calculated by Tripletex |
| `amountIncludingVatCurrency` | number | Read-only | Calculated by Tripletex |

> *Either `unitPriceExcludingVatCurrency` OR `unitPriceIncludingVatCurrency` should be provided, depending on the `isPrioritizeAmountsIncludingVat` flag on the parent Order. If a `product` is referenced, price can be omitted entirely.

#### Order DTO (for POST /order)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `customer` | object `{ id: number }` | **Yes** | Customer reference |
| `orderDate` | string (YYYY-MM-DD) | **Yes** | |
| `deliveryDate` | string (YYYY-MM-DD) | **Yes** | |
| `ourReference` | string | No | Your reference text |
| `yourReference` | string | No | Customer's reference |
| `orderLines` | array of OrderLine | No | Can be embedded or added later |
| `isPrioritizeAmountsIncludingVat` | boolean | No | `true` = use `unitPriceIncludingVatCurrency`, `false` = use `unitPriceExcludingVatCurrency`. Default comes from account invoice settings |
| `currency` | object `{ id: number }` | No | Defaults to customer's currency |
| `invoiceComment` | string | No | Printed on invoice |
| `receiverEmail` | string | No | Override invoice email |
| `invoicesDueIn` | number | No | Payment terms (days) |
| `isSubscription` | boolean | No | Enable subscription invoicing |

#### Customer DTO (for POST /customer)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | **Yes** | |
| `organizationNumber` | string | No | Norwegian org number or foreign VAT ID |
| `email` | string | No | |
| `invoiceEmail` | string | No | |
| `phoneNumber` | string | No | |
| `phoneNumberMobile` | string | No | |
| `postalAddress` | Address object | No | `{ addressLine1, postalCode, city, country: { id } }` |
| `physicalAddress` | Address object | No | |
| `invoiceSendMethod` | string | No | `EMAIL`, `EHF`, `EFAKTURA`, `AVTALEGIRO`, `PAPER` |
| `language` | string | No | `NO`, `EN`, etc. |
| `currency` | object `{ id: number }` | No | Default currency for orders/invoices. Common: `1` = NOK, `5` = EUR |
| `invoicesDueIn` | number | No | Default payment terms |
| `invoicesDueInType` | string | No | `DAYS`, `MONTHS`, etc. |

#### Invoice DTO (for POST /invoice)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `invoiceDate` | string (YYYY-MM-DD) | **Yes** | |
| `invoiceDueDate` | string (YYYY-MM-DD) | No | Auto-calculated from customer terms |
| `orders` | array of Order `{ id }` | **Yes** (for existing orders) | References orders to invoice |
| `invoiceComment` | string | No | |
| `sendToCustomer` | boolean | No | Default `true` in Tripletex |

#### Voucher DTO (for POST /ledger/voucher)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `date` | string (YYYY-MM-DD) | **Yes** | |
| `description` | string | No | |
| `postings` | array of Posting | **Yes** | |

#### Posting (sub-object of Voucher)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `account` | object `{ id: number }` | **Yes** | Ledger account reference |
| `amountGross` | number | **Yes** | Amount in company currency |
| `amountGrossCurrency` | number | No | Amount in foreign currency |
| `date` | string (YYYY-MM-DD) | **Yes** | |
| `vatType` | object `{ id: number }` | No | |
| `row` | number | No | Row number |

#### Product DTO (for POST /product)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | **Yes** | |
| `number` | string | No | Product number / SKU |
| `description` | string | No | |
| `priceExcludingVatCurrency` | number | No* | Depends on account VAT display settings; align with product/invoice settings |
| `priceIncludingVatCurrency` | number | No* | Same as above |
| `vatType` | object `{ id: number }` | No | |
| `currency` | object `{ id: number }` | No | Defaults often from account |
| `isInactive` | boolean | No | |

> *Confirm against OpenAPI for your account if both prices are optional when `vatType` is set.

#### Supplier DTO (for POST /supplier)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | **Yes** | |
| `organizationNumber` | string | No | |
| `email` | string | No | |
| `supplierNumber` | string | No | Internal supplier number |
| `postalAddress` | Address object | No | Same shape as Customer |
| `physicalAddress` | Address object | No | |
| `bankAccountNumber` | string | No | If supported on supplier in your Tripletex version |

#### Timesheet entry DTO (for POST /timesheet/entry)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `activity` | object `{ id: number }` | **Yes** | |
| `project` | object `{ id: number }` | **Yes** | |
| `employee` | object `{ id: number }` | **Yes** | Use token owner or explicit employee |
| `date` | string (YYYY-MM-DD) | **Yes** | |
| `hours` | number | **Yes** | |
| `comment` | string | No | |

### 3.2 Common VAT Type IDs (Norwegian accounts)

| ID | Code | Description |
|----|------|-------------|
| 1 | 0 | No VAT |
| 3 | 3 | 25% Output VAT, high rate |
| 5 | 31 | 15% Output VAT, food |
| 6 | 33 | 12% Output VAT, low rate |
| 7 | 5 | 0% Export / Reverse charge |
| 8 | 6 | 0% Exempt |

> **Important:** These IDs can vary by account. The MCP should expose a `search_vat_types` tool so the LLM can look up the correct ID dynamically via `GET /ledger/vatType`.

### 3.3 Common Currency IDs

| ID | Code |
|----|------|
| 1 | NOK |
| 2 | USD |
| 3 | GBP |
| 5 | EUR |
| 7 | SEK |
| 8 | DKK |

---

## 4. MCP Tool Definitions

### 4.1 Core Invoice Lifecycle

#### `create_order`

Creates an order in Tripletex. Order lines can be embedded.

**Parameters:**

| Param | Type | Required | Maps to Tripletex |
|-------|------|----------|-------------------|
| `customerId` | number | **Yes** | `customer.id` |
| `orderDate` | string | **Yes** | `orderDate` |
| `deliveryDate` | string | **Yes** | `deliveryDate` |
| `orderLines` | array | No | `orderLines[]` |
| `isPrioritizeAmountsIncludingVat` | boolean | No | `isPrioritizeAmountsIncludingVat` |
| `currencyId` | number | No | `currency.id` |
| `ourReference` | string | No | `ourReference` |
| `yourReference` | string | No | `yourReference` |
| `invoiceComment` | string | No | `invoiceComment` |
| `receiverEmail` | string | No | `receiverEmail` |
| `invoicesDueIn` | number | No | `invoicesDueIn` |

**orderLines[] sub-object:**

| Param | Type | Required | Maps to Tripletex |
|-------|------|----------|-------------------|
| `description` | string | No | `description` |
| `count` | number | No | `count` |
| `unitPriceExcludingVatCurrency` | number | No | `unitPriceExcludingVatCurrency` |
| `unitPriceIncludingVatCurrency` | number | No | `unitPriceIncludingVatCurrency` |
| `vatTypeId` | number | No | `vatType.id` |
| `productId` | number | No | `product.id` |
| `discount` | number | No | `discount` |

**Implementation notes:**
- Transform `customerId` → `{ customer: { id: customerId } }`
- Transform `vatTypeId` → `{ vatType: { id: vatTypeId } }`
- Transform `productId` → `{ product: { id: productId } }`
- Transform `currencyId` → `{ currency: { id: currencyId } }`
- Only include price fields that are actually provided (don't send `null` or `0`)
- POST to `/v2/order`

#### `invoice_order`

Converts an existing order to an invoice.

| Param | Type | Required | Maps to Tripletex |
|-------|------|----------|-------------------|
| `orderId` | number | **Yes** | Path: `/v2/order/{orderId}/:invoice` |
| `invoiceDate` | string | **Yes** | Query param `invoiceDate` |
| `sendToCustomer` | boolean | No | Query param `sendToCustomer` (default: `true`) |

**Implementation:** `PUT /v2/order/{orderId}/:invoice?invoiceDate=...&sendToCustomer=...`

#### `create_invoice`

Convenience tool: creates order + immediately invoices it (two-step internally).

| Param | Type | Required |
|-------|------|----------|
| `customerId` | number | **Yes** |
| `invoiceDate` | string | **Yes** |
| `orderLines` | array | **Yes** |
| `isPrioritizeAmountsIncludingVat` | boolean | No |
| `currencyId` | number | No |
| `ourReference` | string | No |
| `invoiceComment` | string | No |
| `sendToCustomer` | boolean | No |

**Implementation:**
1. `POST /v2/order` with `orderDate = invoiceDate`, `deliveryDate = invoiceDate`
2. `PUT /v2/order/{orderId}/:invoice?invoiceDate=...&sendToCustomer=...`
3. Return the resulting invoice object

#### `get_invoice`

| Param | Type | Required |
|-------|------|----------|
| `id` | number | **Yes** |
| `fields` | string | No |

**Implementation:** `GET /v2/invoice/{id}?fields=...`

#### `search_invoices`

| Param | Type | Required |
|-------|------|----------|
| `invoiceDateFrom` | string | **Yes** |
| `invoiceDateTo` | string | **Yes** |
| `customerId` | number | No |
| `isCredited` | boolean | No |
| `count` | number | No |
| `from` | number | No |

**Implementation:** `GET /v2/invoice?invoiceDateFrom=...&invoiceDateTo=...`

### 4.2 Customers

#### `search_customers`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |
| `customerNumber` | string | No |
| `email` | string | No |
| `isActive` | boolean | No |
| `count` | number | No |
| `from` | number | No |

**Implementation:** `GET /v2/customer?name=...&customerNumber=...&email=...&isActive=...&from=...&count=...`

#### `create_customer`

| Param | Type | Required |
|-------|------|----------|
| `name` | string | **Yes** |
| `organizationNumber` | string | No |
| `email` | string | No |
| `invoiceEmail` | string | No |
| `phoneNumber` | string | No |
| `phoneNumberMobile` | string | No |
| `invoiceSendMethod` | string | No |
| `language` | string | No |
| `currencyId` | number | No |
| `postalAddress` | object | No |

**Implementation:** `POST /v2/customer`

#### `update_customer`

| Param | Type | Required |
|-------|------|----------|
| `id` | number | **Yes** |
| (same fields as create) | | |

**Implementation:** `PUT /v2/customer/{id}`

### 4.3 Products

#### `search_products`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |
| `number` | string | No |
| `isInactive` | boolean | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/product?name=...&number=...&isInactive=...&from=...&count=...`

#### `create_product`

| Param | Type | Required |
|-------|------|----------|
| `name` | string | **Yes** |
| `number` | string | No |
| `priceExcludingVatCurrency` | number | No |
| `priceIncludingVatCurrency` | number | No |
| `vatTypeId` | number | No |
| `currencyId` | number | No |
| `description` | string | No |
| `isInactive` | boolean | No |

**Implementation:** `POST /v2/product`

### 4.4 Suppliers

#### `search_suppliers`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |
| `organizationNumber` | string | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/supplier?name=...&organizationNumber=...&from=...&count=...`

#### `create_supplier`

| Param | Type | Required |
|-------|------|----------|
| `name` | string | **Yes** |
| `organizationNumber` | string | No |
| `email` | string | No |
| `postalAddress` | object | No |

**Implementation:** `POST /v2/supplier`

### 4.5 Ledger / Accounting

#### `search_accounts`

Search the chart of accounts.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `query` | string | No | Sent as Tripletex query param `name` |
| `numberFrom` | string | No | Account number range start |
| `numberTo` | string | No | Account number range end |
| `from` | number | No | Pagination offset |
| `count` | number | No | Page size |

**Implementation:** `GET /v2/ledger/account?name=...&numberFrom=...&numberTo=...&from=...&count=...`

#### `search_vat_types`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |

**Implementation:** `GET /v2/ledger/vatType`

#### `create_voucher`

| Param | Type | Required |
|-------|------|----------|
| `date` | string | **Yes** |
| `description` | string | No |
| `postings` | array | **Yes** |

**postings[] sub-object:**

| Param | Type | Required |
|-------|------|----------|
| `accountId` | number | **Yes** |
| `amountGross` | number | **Yes** |
| `amountGrossCurrency` | number | No |
| `date` | string | **Yes** |
| `vatTypeId` | number | No |

**Implementation:** `POST /v2/ledger/voucher` — body: `date`, optional `description`, `postings[]` with each posting expanded: `accountId` → `account: { id }`, `vatTypeId` → `vatType: { id }`, plus `amountGross`, optional `amountGrossCurrency`, `date`, optional `row`.

#### `search_vouchers`

| Param | Type | Required |
|-------|------|----------|
| `dateFrom` | string | **Yes** |
| `dateTo` | string | **Yes** |
| `numberFrom` | string | No |
| `numberTo` | string | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/ledger/voucher?dateFrom=...&dateTo=...&numberFrom=...&numberTo=...&from=...&count=...`

#### `get_voucher`

| Param | Type | Required |
|-------|------|----------|
| `id` | number | **Yes** |
| `fields` | string | No |

**Implementation:** `GET /v2/ledger/voucher/{id}?fields=...`

### 4.6 Supplier Invoices

#### `search_supplier_invoices`

| Param | Type | Required |
|-------|------|----------|
| `invoiceDateFrom` | string | **Yes** |
| `invoiceDateTo` | string | **Yes** |
| `supplierId` | number | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/supplierInvoice?invoiceDateFrom=...&invoiceDateTo=...&supplierId=...&from=...&count=...`

### 4.7 Employees & Time

#### `search_employees`

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `query` | string | No | Map to OpenAPI query params for `GET /employee` (e.g. `firstName` / `lastName`); confirm in v2-docs |
| `from` | number | No | |
| `count` | number | No | |

**Implementation:** `GET /v2/employee?firstName=...&lastName=...&from=...&count=...` (exact filter names must match [v2-docs](https://tripletex.no/v2-docs/) for `/employee`)

#### `search_projects`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/project?name=...&from=...&count=...`

#### `search_activities`

| Param | Type | Required |
|-------|------|----------|
| `query` | string | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/activity?name=...&from=...&count=...`

#### `create_time_entry`

| Param | Type | Required |
|-------|------|----------|
| `employeeId` | number | **Yes** |
| `projectId` | number | **Yes** |
| `activityId` | number | **Yes** |
| `date` | string | **Yes** |
| `hours` | number | **Yes** |
| `comment` | string | No |

**Implementation:** `POST /v2/timesheet/entry` — body: `activity: { id: activityId }`, `project: { id: projectId }`, `employee: { id: employeeId }`, `date`, `hours`, optional `comment`.

#### `search_time_entries`

| Param | Type | Required |
|-------|------|----------|
| `dateFrom` | string | **Yes** |
| `dateTo` | string | **Yes** |
| `employeeId` | number | No |
| `projectId` | number | No |
| `from` | number | No |
| `count` | number | No |

**Implementation:** `GET /v2/timesheet/entry?dateFrom=...&dateTo=...&employeeId=...&projectId=...&from=...&count=...`

### 4.8 Balance / Reporting

#### `get_balance_sheet`

| Param | Type | Required |
|-------|------|----------|
| `dateFrom` | string | **Yes** |
| `dateTo` | string | **Yes** |
| `accountNumberFrom` | number | No |
| `accountNumberTo` | number | No |

**Implementation:** `GET /v2/balanceSheet?dateFrom=...&dateTo=...&accountNumberFrom=...&accountNumberTo=...` (pass through any additional filters the OpenAPI lists, e.g. `customerId`, `employeeId`, `departmentId`, `projectId`, `includeSubProjects`, `activeAccountsWithoutMovements`, `from`, `count`)

### 4.9 Utility

#### `whoami`

Returns info about the authenticated user/company. No parameters.

**Implementation:** `GET /v2/token/session/>whoAmI`

---

## 5. Implementation Requirements

### 5.1 Request Transformation Layer

The MCP must transform flat tool parameters into the nested DTO structure Tripletex expects:

```typescript
// Example: create_order tool call
// Input from LLM:
{
  customerId: 80810447,
  orderDate: "2026-04-08",
  deliveryDate: "2026-04-08",
  isPrioritizeAmountsIncludingVat: false,
  orderLines: [
    {
      description: "Ad Management & Optimization",
      count: 1,
      unitPriceExcludingVatCurrency: 180,
      vatTypeId: 7
    }
  ]
}

// Transformed to Tripletex API body:
{
  customer: { id: 80810447 },
  orderDate: "2026-04-08",
  deliveryDate: "2026-04-08",
  isPrioritizeAmountsIncludingVat: false,
  orderLines: [
    {
      description: "Ad Management & Optimization",
      count: 1,
      unitPriceExcludingVatCurrency: 180,
      vatType: { id: 7 }
    }
  ]
}
```

**Rules:**
- `*Id` suffix params (e.g., `customerId`, `vatTypeId`, `productId`, `currencyId`) → `{ object: { id: value } }`
- Omit fields that are `null`, `undefined`, or not provided — do NOT send them as `null` or `0`
- Pass through all other fields directly

### 5.2 Response Handling

- Return the full Tripletex API response JSON to the caller
- On error (4xx/5xx), return the Tripletex error body verbatim including `validationMessages`
- Include the HTTP status code in the error response

### 5.3 Authentication

- Accept `consumerToken` and `employeeToken` as MCP server configuration (see §5.5).
- Exchange for a session token via `PUT /v2/token/session/:create?consumerToken=...&employeeToken=...&expirationDate=YYYY-MM-DD`
  - **`expirationDate`** (required by Tripletex for session creation): calendar date until which the session is valid (typically end of next day in the company’s timezone, or “tomorrow” UTC date as a simple default). Implementations should renew the session **before** this date elapses (e.g. when `expirationDate <= today` or on `401`).
- Session validity is bounded by `expirationDate`; renew automatically on expiry or auth failure.
- Use HTTP Basic auth on all API calls: username = `0`, password = `sessionToken`.
- When `TRIPLETEX_ENV=test`, use base URL `https://api-test.tripletex.tech/v2` instead of production (see §7).

### 5.4 Fields Parameter Support

Several GET endpoints support a `fields` query parameter for expanding sub-objects:

```
GET /v2/order/{id}?fields=*,orderLines(*)
GET /v2/invoice/{id}?fields=*,orders(*),orderLines(*)
```

The MCP should accept an optional `fields` string parameter on all GET tools and pass it through.

### 5.5 Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRIPLETEX_CONSUMER_TOKEN` | **Yes** | Consumer token from Tripletex developer portal |
| `TRIPLETEX_EMPLOYEE_TOKEN` | **Yes** | Employee API token from Tripletex (Settings → Integrations → API access) |
| `TRIPLETEX_ENV` | No | Set to `test` to use `https://api-test.tripletex.tech/v2`; omit or any other value for production `https://tripletex.no/v2` |

---

## 6. Testing Checklist

### Critical path: Invoice creation

- [ ] Create order with `unitPriceExcludingVatCurrency` on lines → no field mapping error
- [ ] Create order with `unitPriceIncludingVatCurrency` + `isPrioritizeAmountsIncludingVat: true` → success
- [ ] Create order with only `description` and `count` (no price, using product reference) → success
- [ ] Create order for EUR customer (WideOyster) → correct currency handling
- [ ] Invoice the order via `invoice_order` → invoice created
- [ ] `create_invoice` convenience tool → order + invoice in one call
- [ ] `search_invoices` with date range → returns results
- [ ] `get_invoice` with fields expansion → returns order lines
- [ ] Create order with `ourReference` / `yourReference` set → values appear on order/invoice (must **not** be mapped to `ourContact` or other fields)

### Customer management

- [ ] `search_customers` by name → finds customer
- [ ] `create_customer` with minimal fields → success
- [ ] `create_customer` with foreign VAT number and EUR currency → success

### Error handling

- [ ] Invalid `customerId` → returns Tripletex error message
- [ ] Missing required field → returns validation message
- [ ] Expired session → auto-renews and retries

### VAT handling

- [ ] `search_vat_types` → returns list of available VAT types
- [ ] Order line with `vatTypeId: 3` (25% MVA) → correct VAT calculation
- [ ] Order line with `vatTypeId: 7` (export/reverse charge) for foreign customer → 0% VAT

### Vouchers

- [ ] `create_voucher` with postings each having `date` and `amountGross` → success; debits/credits balance per Tripletex rules
- [ ] Invalid voucher (e.g. unbalanced postings) → Tripletex `validationMessages` returned verbatim

### Invoice send behaviour

- [ ] `invoice_order` without `sendToCustomer` → Tripletex default applies (**`true`** = send); with `sendToCustomer: false` → invoice created but not sent to customer

---

## 7. Test Environment

Tripletex provides a free test environment:

- **URL:** `https://api-test.tripletex.tech/v2`
- **Swagger:** `https://api-test.tripletex.tech/v2-docs/`
- **Test account setup:** https://developer.tripletex.no/docs/documentation/getting-started/1-creating-a-test-account/

All development and testing should happen against the test environment first.

---

## 8. Out of Scope (For Now)

- Subscription/recurring invoicing
- Logistics (pick/pack, backorder)
- Salary/payroll endpoints
- Travel expenses
- Bank reconciliation
- Attachment/document uploads
- Webhooks (Tripletex event subscriptions)

These can be added incrementally after the core is stable.

---

## 9. References

- **Tripletex API v2 Swagger:** https://tripletex.no/v2-docs/
- **Developer documentation:** https://developer.tripletex.no
- **FAQ — Invoice/Order:** https://developer.tripletex.no/docs/documentation/faq/invoice-order/
- **FAQ — General:** https://developer.tripletex.no/docs/documentation/faq/general/
- **GitHub (examples & changelog):** https://github.com/Tripletex/tripletex-api2
- **VAT types guide:** https://developer.tripletex.no/docs/documentation/using-vattypes-vat-codes/

---

## 10. Breaking changes / migration (pre-rebuild → this PRD)

Callers and prompts built against the **legacy** MCP schemas must be updated as follows:

| Area | Legacy (incorrect) | This PRD |
|------|-------------------|----------|
| Order / invoice lines array | `lines` | `orderLines` |
| Quantity | `quantity` | `count` |
| Unit price (excl. VAT) | `unitPriceExclVat` | `unitPriceExcludingVatCurrency` (when order uses excl. VAT amounts) |
| Unit price (incl. VAT) | (not supported) | `unitPriceIncludingVatCurrency` when `isPrioritizeAmountsIncludingVat: true` |
| Order references | Any mapping of “our reference” to contact IDs | `ourReference` / `yourReference` as **strings** on the order body |
| `invoice_order` / `create_invoice` send default | Some implementations used `sendToCustomer: false` by default | Omit to follow Tripletex default (**send**); pass `false` only when the invoice must not be emailed |

After rebuild, tool descriptions and Zod schemas in the MCP server should match §4 verbatim so LLMs pick correct field names.

---

## 11. Maintaining accuracy vs Tripletex

Tripletex may extend or adjust DTOs. Before each release, spot-check critical paths against the live OpenAPI/Swagger:

- Production: https://tripletex.no/v2-docs/
- Test: https://api-test.tripletex.tech/v2-docs/

Update §3 and §4 if field names, required flags, or query parameter names differ. The FAQ remains a strong secondary source for behaviour (e.g. VAT-inclusive vs exclusive unit prices).
