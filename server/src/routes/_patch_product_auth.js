const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "products.js");
let s = fs.readFileSync(filePath, "utf8");

const pairs = [
  ['router.get("/admin/bootstrap", requireSuperAdmin,', 'router.get("/admin/bootstrap", requireProductView,'],
  ['router.get("/admin/list", requireSuperAdmin,', 'router.get("/admin/list", requireProductView,'],
  ['router.get("/admin/:id", requireSuperAdmin,', 'router.get("/admin/:id", requireProductView,'],
  ['router.post("/admin/category", requireSuperAdmin,', 'router.post("/admin/category", requireProductCreate,'],
  ['router.post("/admin/group", requireSuperAdmin,', 'router.post("/admin/group", requireProductCreate,'],
  ['router.post("/admin", requireSuperAdmin,', 'router.post("/admin", requireProductCreate,'],
  ['router.put("/admin/:id", requireSuperAdmin,', 'router.put("/admin/:id", requireProductEdit,'],
  ['router.get("/admin/:id/company-policies", requireSuperAdmin,', 'router.get("/admin/:id/company-policies", requireProductView,'],
  ['router.put("/admin/:id/company-policy", requireSuperAdmin,', 'router.put("/admin/:id/company-policy", requireProductEdit,'],
  ['router.put("/admin/:id/company-policies/pair", requireSuperAdmin,', 'router.put("/admin/:id/company-policies/pair", requireProductEdit,'],
  ['router.post("/admin/import/preview", requireSuperAdmin,', 'router.post("/admin/import/preview", requireProductEdit,'],
  ['router.post("/admin/import/apply", requireSuperAdmin,', 'router.post("/admin/import/apply", requireProductApprove,'],
  ['router.get("/admin/import/template", requireSuperAdmin,', 'router.get("/admin/import/template", requireProductView,'],
  ['router.get("/admin/import/current-workbook", requireSuperAdmin,', 'router.get("/admin/import/current-workbook", requireProductView,'],
];

for (const [from, to] of pairs) {
  if (!s.includes(from)) {
    console.error("MISSING:", from);
    process.exit(1);
  }
  s = s.split(from).join(to);
}

fs.writeFileSync(filePath, s);
console.log("product auth middleware updated");
