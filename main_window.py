# app/ui/main_window.py
import tkinter as tk
from tkinter import ttk
from scheduler import Scheduler
from components import create_queue_frame, draw_thread_card, create_cpu_frame

class MainWindow:
    def __init__(self, root):
        self.root = root
        self.root.title("OS Thread Simulator (Multi-Core & Advanced Scheduling)")
        self.root.geometry("1300x850") # Widened for extra queue
        self.root.configure(bg="#F8FAFC")

        # Connect to Logic Engine
        self.scheduler = Scheduler()
        self.is_running = False
        self.speed_var = tk.IntVar(value=1000) # ms
        
        # UI References
        self.cpu_widgets = {} 
        self._setup_ui()

    def _setup_ui(self):
        # --- STYLE ---
        style = ttk.Style()
        style.theme_use('clam')
        style.configure("TFrame", background="#F8FAFC")
        style.configure("Header.TLabel", font=("Segoe UI", 16, "bold"), foreground="#312E81")

        # --- TOP HEADER ---
        header_frame = ttk.Frame(self.root)
        header_frame.pack(side="top", fill="x", padx=15, pady=15)
        ttk.Label(header_frame, text="Thread OS Simulator", style="Header.TLabel").pack(side="left")
        
        self.btn_run = tk.Button(header_frame, text="Run", bg="#22C55E", fg="white", font=("Segoe UI", 10, "bold"), command=self.toggle_simulation)
        self.btn_run.pack(side="left", padx=20)
        
        btn_reset = tk.Button(header_frame, text="Reset", bg="#94A3B8", fg="white", font=("Segoe UI", 10, "bold"), command=self.reset_simulation)
        btn_reset.pack(side="left")

        # --- MAIN GRID ---
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill="both", expand=True, padx=15, pady=5)

        # 1. LEFT PANEL (Controls)
        left_panel = tk.Frame(main_frame, bg="white", padx=10, pady=10)
        left_panel.grid(row=0, column=0, sticky="nsew", padx=5)
        
        # New Thread Section
        tk.Label(left_panel, text="Create Thread", font=("Segoe UI", 11, "bold"), bg="white").pack(anchor="w", pady=(0, 5))
        
        tk.Label(left_panel, text="Burst Time:", bg="white").pack(anchor="w")
        self.burst_var = tk.IntVar(value=5)
        tk.Spinbox(left_panel, from_=1, to=50, textvariable=self.burst_var, width=10).pack(anchor="w")
        
        tk.Label(left_panel, text="Priority (High=High):", bg="white").pack(anchor="w")
        self.priority_var = tk.IntVar(value=1)
        tk.Spinbox(left_panel, from_=1, to=10, textvariable=self.priority_var, width=10).pack(anchor="w")
        
        tk.Label(left_panel, text="Arrival Time:", bg="white").pack(anchor="w")
        self.arrival_var = tk.IntVar(value=0)
        tk.Spinbox(left_panel, from_=0, to=100, textvariable=self.arrival_var, width=10).pack(anchor="w")
        
        tk.Button(left_panel, text="Add Thread", bg="#4F46E5", fg="white", command=self.create_thread).pack(fill="x", pady=10)
        
        ttk.Separator(left_panel, orient="horizontal").pack(fill="x", pady=10)
        
        # Configuration Section
        tk.Label(left_panel, text="System Config", font=("Segoe UI", 11, "bold"), bg="white").pack(anchor="w")
        
        tk.Label(left_panel, text="Algorithm:", bg="white").pack(anchor="w", pady=(5, 0))
        self.algo_var = tk.StringVar(value="RR")
        algo_cb = ttk.Combobox(left_panel, textvariable=self.algo_var, values=["FCFS", "SJF", "PRIORITY", "RR"], state="readonly")
        algo_cb.pack(fill="x")
        
        tk.Label(left_panel, text="CPU Cores:", bg="white").pack(anchor="w", pady=(5, 0))
        self.cpu_count_var = tk.IntVar(value=1)
        tk.Spinbox(left_panel, from_=1, to=4, textvariable=self.cpu_count_var, width=10).pack(anchor="w")
        
        tk.Label(left_panel, text="Time Quantum (RR):", bg="white").pack(anchor="w", pady=(5, 0))
        self.quantum_var = tk.IntVar(value=3)
        tk.Spinbox(left_panel, from_=1, to=20, textvariable=self.quantum_var, width=10).pack(anchor="w")
        
        self.preempt_var = tk.BooleanVar(value=False)
        tk.Checkbutton(left_panel, text="Preemptive (SJF/Prio)", variable=self.preempt_var, bg="white").pack(anchor="w", pady=5)

        tk.Label(left_panel, text="Speed (ms):", bg="white").pack(anchor="w", pady=(5, 0))
        tk.Scale(left_panel, from_=100, to=2000, orient="horizontal", variable=self.speed_var, bg="white").pack(fill="x")

        ttk.Separator(left_panel, orient="horizontal").pack(fill="x", pady=10)
        self.lbl_time = tk.Label(left_panel, text="Time: 0s", font=("Courier", 14, "bold"), bg="white", fg="#312E81")
        self.lbl_time.pack(anchor="w")

        # 2. CENTER PANEL (Queues & CPUs)
        center_panel = ttk.Frame(main_frame)
        center_panel.grid(row=0, column=1, sticky="nsew", padx=15)
        
        # Queues Container
        queue_container = ttk.Frame(center_panel)
        queue_container.pack(fill="x", expand=False)
        
        # Added Job Queue (NEW State)
        self.job_frame = create_queue_frame(queue_container, "Job Queue (Waiting)", "#64748B", 0)
        self.ready_frame = create_queue_frame(queue_container, "Ready Queue", "#22C55E", 1)
        self.blocked_frame = create_queue_frame(queue_container, "Blocked Queue", "#EF4444", 2)
        
        # CPU Container
        tk.Label(center_panel, text="Processing Units", font=("Segoe UI", 10, "bold"), bg="#F8FAFC").pack(anchor="w", pady=(10,0))
        self.cpu_main_container = tk.Frame(center_panel, bg="#F8FAFC")
        self.cpu_main_container.pack(fill="both", expand=True)

        # Terminated
        term_frame = tk.Frame(center_panel, bg="#F1F5F9", padx=10, pady=10)
        term_frame.pack(fill="x")
        tk.Label(term_frame, text="Terminated Threads", bg="#F1F5F9").pack(anchor="w")
        self.term_content = tk.Frame(term_frame, bg="#F1F5F9")
        self.term_content.pack(fill="x", pady=5)

        # 3. RIGHT PANEL (Gantt & Logs)
        right_panel = ttk.Frame(main_frame)
        right_panel.grid(row=0, column=2, sticky="nsew", padx=5)
        
        self.canvas = tk.Canvas(right_panel, bg="white", height=300, width=300)
        self.canvas.pack(fill="both", pady=(0, 20))
        
        self.log_list = tk.Listbox(right_panel, bg="#1E293B", fg="#CBD5E1", font=("Courier", 8), height=15)
        self.log_list.pack(fill="both", expand=True)

        # Grid Weights
        main_frame.columnconfigure(1, weight=2)
        main_frame.columnconfigure(2, weight=1)
        
        # Initial Render
        self._refresh_cpu_grid()

    # --- INTERACTION ---
    def create_thread(self):
        try:
            # Safe Get to prevent crashes if fields are empty
            burst = int(self.burst_var.get())
            prio = int(self.priority_var.get())
            arrival = int(self.arrival_var.get())
            
            self.scheduler.create_thread(burst, prio, arrival)
            self.update_ui()
        except Exception as e:
            print(f"Error creating thread: {e}")
            # Optional: Show error to user via a messagebox (not added to keep it simple)

    def toggle_simulation(self):
        if self.is_running:
            self.is_running = False
            self.btn_run.config(text="Run", bg="#22C55E")
        else:
            self.scheduler.update_config(
                self.algo_var.get(), 
                self.cpu_count_var.get(), 
                self.preempt_var.get(),
                self.quantum_var.get()
            )
            self._refresh_cpu_grid()
            
            self.is_running = True
            self.btn_run.config(text="Pause", bg="#F97316")
            self.run_loop()

    def reset_simulation(self):
        self.is_running = False
        self.scheduler.reset()
        self.log_list.delete(0, tk.END)
        self.btn_run.config(text="Run", bg="#22C55E")
        self.update_ui()

    def run_loop(self):
        if not self.is_running: return
        self.scheduler.next_tick()
        self.update_ui()
        self.root.after(self.speed_var.get(), self.run_loop)
        
    def _refresh_cpu_grid(self):
        # Clear existing
        for widget in self.cpu_main_container.winfo_children():
            widget.destroy()
        self.cpu_widgets = {}
        
        # Build new
        count = self.cpu_count_var.get()
        for i in range(count):
            _, content = create_cpu_frame(self.cpu_main_container, i)
            self.cpu_widgets[i] = content

    # --- UI UPDATES ---
    def update_ui(self):
        self.lbl_time.config(text=f"Time: {self.scheduler.current_time}s")
        
        # Refresh Logs
        self.log_list.delete(0, tk.END)
        for log in self.scheduler.logs:
            self.log_list.insert(tk.END, log)

        # Clear Containers
        for widget in self.job_frame.winfo_children(): widget.destroy()
        for widget in self.ready_frame.winfo_children(): widget.destroy()
        for widget in self.blocked_frame.winfo_children(): widget.destroy()
        for widget in self.term_content.winfo_children(): widget.destroy()
        for cid in self.cpu_widgets:
             for widget in self.cpu_widgets[cid].winfo_children(): widget.destroy()

        # Draw Threads
        for t in self.scheduler.threads:
            if t.state == "NEW":
                # Draw simple card for Job Queue
                f = tk.Frame(self.job_frame, bg="white", bd=1, relief="raised", padx=5)
                f.pack(fill="x", pady=2)
                tk.Label(f, text=f"T{t.id} (Arr: {t.arrival_time})", bg="white", fg="gray", font=("Arial", 9)).pack(anchor="w")
                
            elif t.state == "READY":
                draw_thread_card(self.ready_frame, t, self.scheduler.force_block, self.scheduler.unblock)
            elif t.state == "BLOCKED":
                draw_thread_card(self.blocked_frame, t, self.scheduler.force_block, self.scheduler.unblock)
            elif t.state == "RUNNING":
                if t.cpu_id in self.cpu_widgets:
                    draw_thread_card(self.cpu_widgets[t.cpu_id], t, self.scheduler.force_block, self.scheduler.unblock)
            elif t.state == "TERMINATED":
                tk.Label(self.term_content, text=f"T{t.id}", bg=t.color, fg="white", padx=5).pack(side="left", padx=2)

        self.draw_gantt()

    def draw_gantt(self):
        self.canvas.delete("all")
        row_height, time_scale, y_start = 30, 10, 20
        req_width = max(300, self.scheduler.current_time * time_scale + 50)
        
        self.canvas.config(scrollregion=(0,0, req_width, len(self.scheduler.threads) * row_height + 50))
        
        y = y_start
        for t in self.scheduler.threads:
            self.canvas.create_text(20, y + 10, text=f"T{t.id}", font=("Arial", 8, "bold"))
            self.canvas.create_line(40, y + 10, req_width, y + 10, fill="#E2E8F0")
            for start, end, state in t.history:
                if state == "RUNNING":
                    x1, x2 = 40 + (start * time_scale), 40 + (end * time_scale)
                    self.canvas.create_rectangle(x1, y+2, x2, y+18, fill=t.color, outline="")
            y += row_height
            
        for i in range(0, self.scheduler.current_time + 5, 5):
            x = 40 + (i * time_scale)
            self.canvas.create_line(x, 0, x, y, fill="#E2E8F0", dash=(2, 2))
            self.canvas.create_text(x, y + 10, text=str(i), font=("Arial", 7))