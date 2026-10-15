import { callWorkOrder, closeWorkOrders } from "../../src/work-order-pool.js";
const [parent, id] = process.argv.slice(2);
try {
  const snapshot = await callWorkOrder(parent!, id!, { type: "snapshot" });
  console.log(JSON.stringify({ id: snapshot.order.id, agentId: snapshot.agentId, ownerActions: snapshot.ownerActions }));
} finally { await closeWorkOrders(); }
