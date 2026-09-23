const express = require("express");
const router = express.Router({ mergeParams: true });
const authMiddleware = require("../middleware/authMiddleware");
const {
  getBillConfig,
  saveBillConfig,
  deleteBillConfig,
} = require("../controllers/billController");

router.use(authMiddleware);

router.get("/config/:memberType", getBillConfig);
router.put("/config/:memberType", saveBillConfig);
router.delete("/config/:memberType", deleteBillConfig);

module.exports = router;