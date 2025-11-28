# Neon OS Simulator

A modern, interactive Operating System Simulator built with React and Tailwind CSS. This web application visualizes core OS concepts including process scheduling, threading models, synchronization primitives, and resource management in a real-time, "Neon Night" themed interface.

## 🚀 Features

### 1. Process Scheduling
-   **Round Robin (RR) Algorithm**: Visualizes time-sliced execution with a configurable time quantum.
-   **Dynamic CPU Count**: Simulate single-core or multi-core systems (up to 4 CPUs).
-   **Process States**: Visual representation of NEW, READY, RUNNING, BLOCKED, and TERMINATED states.

### 2. Threading Models
Explore how different threading models affect concurrency and blocking behavior:
-   **One-to-One (1:1)**: Each user thread maps to a kernel thread. High concurrency; blocking one thread doesn't affect others in the same process.
-   **Many-to-One (M:1)**: Multiple user threads map to a single kernel thread. If one thread blocks on a system call, the entire process blocks.
-   **Many-to-Many (M:M)**: Hybrid model with a pool of Lightweight Processes (LWPs).
-   **LWP Highway Visualizer**: A dedicated view showing the mapping of User Threads to Kernel Threads (LWPs) in real-time, visualizing the "Highway" lanes where threads travel.

### 3. Synchronization & Deadlocks
Interactive demonstration of synchronization primitives:
-   **System Resources (Kernel Objects)**:
    -   **Mutexes**: Binary locks (e.g., Database).
    -   **Semaphores**: Counting semaphores (e.g., Printer, Disk I/O).
-   **Monitors**:
    -   **Mesa Semantics**: Visualizes Monitor Entry Queue, Condition Variables (Wait/Signal), and Lock ownership.
    -   **Buffer Monitor**: Simulate a Producer-Consumer scenario with `NotEmpty` and `NotFull` condition variables.

### 4. Interactive Controls
-   **Simulation Control**: Play, Pause (with **Auto-Pause** on idle), and Reset the simulation clock.
-   **Speed Control**: Adjust the simulation speed from slow-motion to fast-forward.
-   **Process Creation**: Spawn new processes with custom:
    -   Thread Count
    -   Burst Time
    -   Burst Time
    -   Priority
-   **Resource Time Limit**: Configure a maximum time a thread can hold a resource before being force-released (prevents deadlocks/hogging).
-   **In-App User Manual**: Built-in interactive guide with test cases and concept explanations.

### 5. Real-time Visualization
-   **Gantt-style CPU View**: See which thread is running on which CPU.
-   **Queues**: Inspect the Ready Queue and Blocked Queue in real-time.
-   **Resource Status**: View current holders and waiting queues for all resources.
-   **Event Log**: Detailed log of all system events (Context Switches, Resource Acquisition, Thread Termination).

## 🛠️ Tech Stack

-   **Frontend Framework**: [React](https://react.dev/) (v18+)
-   **Build Tool**: [Vite](https://vitejs.dev/)
-   **Styling**: [Tailwind CSS](https://tailwindcss.com/)
-   **Icons**: [Lucide React](https://lucide.dev/)
-   **State Management**: React `useReducer` for complex simulation state.

## 📦 Installation & Setup

1.  **Prerequisites**: Ensure you have [Node.js](https://nodejs.org/) installed.

2.  **Install Dependencies**:
    Navigate to the project directory and run:
    ```bash
    npm install
    ```

3.  **Run Development Server**:
    Start the local development server:
    ```bash
    npm run dev
    ```
    The app will be available at `http://localhost:5173` (or the port shown in your terminal).

4.  **Build for Production**:
    To create a production-ready build:
    ```bash
    npm run build
    ```

## 📖 Usage Guide

### Dashboard Overview
-   **Top Bar**: Displays the current Threading Model and Global Simulation Time.
-   **Left Panel (Controls)**:
    -   **Playback**: Toggle simulation run state and reset.
    -   **Config**: Change Threading Model, CPU Count, and Simulation Speed.
    -   **Spawner**: Create new user processes.
-   **Center Panel (Visualization)**:
    -   **CPUs**: Active threads currently executing.
    -   **Ready Queue**: Threads waiting for CPU time.
    -   **Blocked Queue**: Threads waiting for I/O or Synchronization primitives.
-   **Right Panel (Resources)**:
    -   **Monitor**: Visualizes the internal state of the 'Buffer' monitor.
    -   **Kernel Resources**: Status of Database, Printer, and Disk I/O.
    -   **Logs**: Real-time system event stream.

### Simulating Scenarios
1.  **Concurrency Test**: Set CPUs to 2 or 4. Create multiple processes. Watch them share CPU time via Round Robin.
2.  **Blocking Behavior**:
    -   Set Model to **Many-to-One**.
    -   Have a running thread request a "Printer" (System Resource).
    -   Observe that *other threads of the same process* cannot run even if CPUs are free (Process Blocking).
    -   Switch to **One-to-One** and observe the difference (only the requesting thread blocks).
3.  **Synchronization**:
    -   Have a thread **Enter Monitor**.
    -   Have another thread try to Enter. It will be placed in the **Entry Queue**.
    -   Have the owner **Wait** on a Condition Variable. It releases the lock and moves to the CV Queue.
    -   Have another thread Enter and **Signal**.

## 📂 Project Structure

```
web app/
├── public/             # Static assets
├── src/
│   ├── assets/         # Project assets
│   ├── App.css         # Global styles
│   ├── App.jsx         # Main Application Component (Logic & UI)
│   ├── index.css       # Tailwind directives
│   └── main.jsx        # Entry point
├── index.html          # HTML template
├── package.json        # Dependencies and scripts
├── tailwind.config.js  # Tailwind configuration
└── vite.config.js      # Vite configuration
```

## 🤝 Contributing

Feel free to fork this project and submit pull requests. For major changes, please open an issue first to discuss what you would like to change.

---
*Built for OS Project - Semester 3*
