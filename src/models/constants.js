// Shared enums (these used to live inside the Mongoose models).
module.exports = {
    ROLES: ['Admin', 'Marketing', 'Supervisor', 'Manager', 'Operator', 'Driver'],
    ORDER_STATUSES: ['Pending', 'Confirmed', 'Ready to Dispatch', 'On the Way', 'Completed', 'Cancelled'],
    PAYMENT_MODES: ['Cash', 'Credit'], // chosen on the ORDER
    PAYMENT_METHODS: ['Cash', 'Online'], // how money was actually collected
    VEHICLE_TYPES: ['truck', 'pickup', 'magic', 'auto', 'toto'],
};
