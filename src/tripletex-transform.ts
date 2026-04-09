/**
 * Maps MCP tool payloads to Tripletex v2 JSON bodies (PRD §5.1).
 */

export type OrderLineInput = {
  description?: string;
  count?: number;
  unitPriceExcludingVatCurrency?: number;
  unitPriceIncludingVatCurrency?: number;
  vatTypeId?: number;
  productId?: number;
  discount?: number;
};

export function transformOrderLine(line: OrderLineInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (line.description !== undefined) out.description = line.description;
  if (line.count !== undefined) out.count = line.count;
  if (line.unitPriceExcludingVatCurrency !== undefined) {
    out.unitPriceExcludingVatCurrency = line.unitPriceExcludingVatCurrency;
  }
  if (line.unitPriceIncludingVatCurrency !== undefined) {
    out.unitPriceIncludingVatCurrency = line.unitPriceIncludingVatCurrency;
  }
  if (line.vatTypeId !== undefined) out.vatType = { id: line.vatTypeId };
  if (line.productId !== undefined) out.product = { id: line.productId };
  if (line.discount !== undefined) out.discount = line.discount;
  return out;
}

export type CreateOrderInput = {
  customerId: number;
  orderDate: string;
  deliveryDate: string;
  orderLines?: OrderLineInput[];
  isPrioritizeAmountsIncludingVat?: boolean;
  currencyId?: number;
  ourReference?: string;
  yourReference?: string;
  invoiceComment?: string;
  receiverEmail?: string;
  invoicesDueIn?: number;
};

export function buildOrderBody(input: CreateOrderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    customer: { id: input.customerId },
    orderDate: input.orderDate,
    deliveryDate: input.deliveryDate,
  };
  if (input.orderLines !== undefined && input.orderLines.length > 0) {
    body.orderLines = input.orderLines.map(transformOrderLine);
  }
  if (input.isPrioritizeAmountsIncludingVat !== undefined) {
    body.isPrioritizeAmountsIncludingVat = input.isPrioritizeAmountsIncludingVat;
  }
  if (input.currencyId !== undefined) body.currency = { id: input.currencyId };
  if (input.ourReference !== undefined) body.ourReference = input.ourReference;
  if (input.yourReference !== undefined) body.yourReference = input.yourReference;
  if (input.invoiceComment !== undefined) body.invoiceComment = input.invoiceComment;
  if (input.receiverEmail !== undefined) body.receiverEmail = input.receiverEmail;
  if (input.invoicesDueIn !== undefined) body.invoicesDueIn = input.invoicesDueIn;
  return body;
}

export type VoucherPostingInput = {
  accountId: number;
  amountGross: number;
  amountGrossCurrency?: number;
  date: string;
  vatTypeId?: number;
  row?: number;
};

export function transformVoucherPosting(p: VoucherPostingInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    account: { id: p.accountId },
    amountGross: p.amountGross,
    date: p.date,
  };
  if (p.amountGrossCurrency !== undefined) out.amountGrossCurrency = p.amountGrossCurrency;
  if (p.vatTypeId !== undefined) out.vatType = { id: p.vatTypeId };
  if (p.row !== undefined) out.row = p.row;
  return out;
}
