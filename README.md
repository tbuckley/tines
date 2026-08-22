# tines

An orchestration layer for AI agents, allowing you to create an ecosystem of agents collaborating towards your goals.

The core of Tines is an issue tracker, which makes work legible to both humans and agents. It acts as a log of work, actions taken, and hand offs. Issues move between states according to workflows, finite state machines that define the allowed transitions and roles for each state.

Tines acts as a supervisor, assigning tasks to agents across managed services (using your own API keys) as well as local devices (using your own subscriptions).