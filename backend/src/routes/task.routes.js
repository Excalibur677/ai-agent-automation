const router = require("express").Router();
const authMiddleware = require("../middleware/auth.middleware");
const {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  approveTask,
  rejectTask,
  resumeTask,
} = require("../controllers/task.controller");

router.post("/", authMiddleware, createTask);
router.get("/", authMiddleware, listTasks);
router.get("/:id", authMiddleware, getTask);
router.put("/:id", authMiddleware, updateTask);
router.delete("/:id", authMiddleware, deleteTask);

// HITL Approval routes
router.post("/:id/approve", authMiddleware, approveTask);
router.post("/:id/reject", authMiddleware, rejectTask);
router.post("/:id/resume", authMiddleware, resumeTask);

module.exports = router;
