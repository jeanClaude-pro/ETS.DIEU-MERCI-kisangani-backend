const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["admin", "manager", "inventory_manager", "cashier_supervisor", "staff"],
      default: "staff",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Approval lifecycle. `default: "active"` is deliberate: pre-existing
    // documents that predate this field hydrate as "active", matching their
    // existing `isActive` value, so legacy accounts need no migration.
    // New self-registrations explicitly override this to "pending".
    status: {
      type: String,
      enum: ["pending", "active", "suspended", "rejected"],
      default: "active",
    },
    // undefined = not customized yet, fall back to the role's default module
    // set (see server/config/modulePermissions.js). Admin role always has
    // full access regardless of this field.
    modulePermissions: {
      type: [String],
      default: undefined,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    history: [
      {
        action: {
          type: String,
          enum: [
            "requested",
            "approved",
            "rejected",
            "role_changed",
            "permissions_changed",
            "suspended",
            "reactivated",
          ],
          required: true,
        },
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        performedByUsername: {
          type: String,
          default: null,
        },
        at: {
          type: Date,
          default: Date.now,
        },
        details: {
          type: mongoose.Schema.Types.Mixed,
          default: null,
        },
      },
    ],
  },
  { timestamps: true }
);

// Keep isActive and status from ever contradicting each other: whichever
// code path changes `status`, `isActive` follows automatically.
userSchema.pre("save", function syncActiveWithStatus(next) {
  if (this.isModified("status")) {
    this.isActive = this.status === "active";
  }
  next();
});

// Consistent `id` (not `_id`) in any JSON response, matching the shape
// auth.js's login already returns; also strips password/__v defensively.
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);