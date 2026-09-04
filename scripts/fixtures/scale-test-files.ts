/**
 * The same real, deliberately-structural 10-file diff used by
 * `dry-run-live-scale.ts` (routes -> controllers -> services -> workers ->
 * migrations, real EventBus/PaymentGateway/NotificationService external
 * calls) — extracted here so `measure-model-cost.ts` can reuse it verbatim
 * as a genuine node-cap/self-loop/category-adherence stress test instead of
 * inventing a different fixture that might happen to be easier or harder.
 */
import type { ChangedFile } from "../../action/src/diff.js";

export const SCALE_TEST_FILES: ChangedFile[] = [
  {
    filename: "src/routes/orders.ts",
    status: "modified",
    additions: 6,
    deletions: 0,
    patch: [
      "@@ -3,2 +3,8 @@",
      "+router.post('/orders', ordersController.create)",
      "+router.get('/orders/:id', ordersController.get)",
      "+router.post('/orders/:id/cancel', ordersController.cancel)",
    ].join("\n"),
  },
  {
    filename: "src/routes/refunds.ts",
    status: "added",
    additions: 4,
    deletions: 0,
    patch: ["@@ -0,0 +1,4 @@", "+router.post('/refunds', refundsController.create)"].join("\n"),
  },
  {
    filename: "src/controllers/ordersController.ts",
    status: "modified",
    additions: 12,
    deletions: 2,
    patch: [
      "@@ -10,2 +10,12 @@",
      "+export async function create(req, res) {",
      "+  const order = await OrderService.createOrder(req.user.id, req.body.cart)",
      "+  await InventoryService.reserveStock(order.items)",
      "+  res.json(order)",
      "+}",
      "+export async function cancel(req, res) {",
      "+  await OrderService.cancelOrder(req.params.id)",
      "+  await RefundService.issueRefund(req.params.id)",
      "+}",
    ].join("\n"),
  },
  {
    filename: "src/controllers/refundsController.ts",
    status: "added",
    additions: 6,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,6 @@",
      "+export async function create(req, res) {",
      "+  const refund = await RefundService.issueRefund(req.body.orderId)",
      "+  res.json(refund)",
      "+}",
    ].join("\n"),
  },
  {
    filename: "src/services/orderService.ts",
    status: "modified",
    additions: 10,
    deletions: 1,
    patch: [
      "@@ -5,1 +5,10 @@",
      "+export async function createOrder(userId, cart) {",
      "+  const order = await db.orders.insert({ userId, cart })",
      "+  await EventBus.publish('order.created', order)",
      "+  return order",
      "+}",
      "+export async function cancelOrder(orderId) {",
      "+  await db.orders.update(orderId, { status: 'cancelled' })",
      "+}",
    ].join("\n"),
  },
  {
    filename: "src/services/refundService.ts",
    status: "added",
    additions: 8,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,8 @@",
      "+export async function issueRefund(orderId) {",
      "+  const order = await db.orders.findById(orderId)",
      "+  const refund = await db.refunds.insert({ orderId, amount: order.total })",
      "+  await PaymentGateway.refund(order.paymentId, order.total)",
      "+  return refund",
      "+}",
    ].join("\n"),
  },
  {
    filename: "src/services/inventoryService.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch: ["@@ -8,0 +8,3 @@", "+export async function reserveStock(items) {", "+  await db.inventory.decrement(items)", "+}"].join(
      "\n"
    ),
  },
  {
    filename: "src/workers/refundWorker.ts",
    status: "added",
    additions: 5,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,5 @@",
      "+EventBus.subscribe('refund.issued', async (refund) => {",
      "+  await NotificationService.sendRefundConfirmation(refund)",
      "+})",
    ].join("\n"),
  },
  {
    filename: "db/migrations/024_add_refunds_table.sql",
    status: "added",
    additions: 7,
    deletions: 0,
    patch: [
      "@@ -0,0 +1,7 @@",
      "+CREATE TABLE refunds (",
      "+  id uuid PRIMARY KEY,",
      "+  order_id uuid REFERENCES orders(id),",
      "+  amount integer NOT NULL,",
      "+  created_at timestamptz DEFAULT now()",
      "+);",
    ].join("\n"),
  },
  {
    filename: "db/migrations/025_add_cancelled_status.sql",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: ["@@ -4,0 +4,1 @@", "+ALTER TABLE orders ADD COLUMN status text DEFAULT 'active';"].join("\n"),
  },
];
